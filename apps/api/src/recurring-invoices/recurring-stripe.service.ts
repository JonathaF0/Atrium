import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type Stripe from "stripe";
import { PrismaService } from "../prisma/prisma.service";
import { PaymentsService } from "../payments/payments.service";
import { BillingService } from "../billing/billing.service";
import { calculateInvoiceTotal } from "../payments/invoice-total";
import { getCurrency } from "../common/helpers/currency";

export type ChargeOutcome =
  | { status: "skipped"; reason: string }
  | { status: "paid"; paymentIntentId: string }
  | { status: "pending"; paymentIntentId: string }
  | { status: "failed"; reason: string };

interface ScheduleForCharge {
  id: string;
  organizationId: string;
  autoCharge: boolean;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
}

interface InvoiceForCharge {
  id: string;
  invoiceNumber: string;
  status: string;
  type: string;
  amount: number | null;
  lineItems: Array<{ quantity: number; unitPrice: number }>;
}

/**
 * Saved cards and off-session charges for billing schedules, on the
 * workspace's own Stripe setup (direct keys or Connect). Cards are collected
 * with Checkout in setup mode and confirmed by reading the session back from
 * Stripe, so no webhook changes are needed; charges are confirmed
 * synchronously and recorded through the same path Checkout payments use.
 */
@Injectable()
export class RecurringStripeService {
  private readonly logger = new Logger(RecurringStripeService.name);
  private readonly webUrl: string;
  private readonly currency: string;

  constructor(
    private prisma: PrismaService,
    private payments: PaymentsService,
    private billing: BillingService,
    private config: ConfigService,
  ) {
    this.webUrl = this.config.get<string>("WEB_URL", "http://localhost:3000").replace(/\/+$/, "");
    this.currency = getCurrency(this.config);
  }

  /** True when the workspace can take online payments right now. */
  async isAvailable(organizationId: string): Promise<boolean> {
    try {
      const [status, entitled] = await Promise.all([
        this.payments.getPaymentStatus(organizationId),
        this.billing.hasFeature(organizationId, "online_payments"),
      ]);
      return status.enabled && entitled;
    } catch {
      return false;
    }
  }

  private requestOptions(stripeAccount?: string): Stripe.RequestOptions | undefined {
    return stripeAccount ? { stripeAccount } : undefined;
  }

  /** Starts a Checkout session in setup mode; returns the URL to send the client to. */
  async startCardSetup(
    schedule: { id: string; organizationId: string; stripeCustomerId: string | null },
    client: { email: string; name: string },
  ): Promise<{ url: string }> {
    if (!(await this.isAvailable(schedule.organizationId))) {
      throw new BadRequestException("Online payments are not configured");
    }
    const { stripe, stripeAccount } = await this.payments.getStripeConfig(schedule.organizationId);
    const opts = this.requestOptions(stripeAccount);

    let customerId = schedule.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create(
        {
          email: client.email,
          name: client.name,
          metadata: { organizationId: schedule.organizationId, recurringInvoiceId: schedule.id },
        },
        opts,
      );
      customerId = customer.id;
      await this.prisma.recurringInvoice.update({
        where: { id: schedule.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const metadata = { organizationId: schedule.organizationId, recurringInvoiceId: schedule.id, purpose: "recurring_card" };
    const session = await stripe.checkout.sessions.create(
      {
        mode: "setup",
        customer: customerId,
        payment_method_types: ["card"],
        success_url: `${this.webUrl}/portal/billing?card=saved&plan=${encodeURIComponent(schedule.id)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${this.webUrl}/portal/billing?card=cancelled`,
        metadata,
        setup_intent_data: { metadata },
      },
      opts,
    );
    if (!session.url) throw new BadRequestException("Stripe did not return a checkout URL");
    return { url: session.url };
  }

  /**
   * Reads a completed setup session back from Stripe and returns the saved
   * payment method. Every field that ties it to this schedule is checked.
   */
  async confirmCardSetup(
    schedule: { id: string; organizationId: string; stripeCustomerId: string | null },
    sessionId: string,
  ): Promise<string> {
    const { stripe, stripeAccount } = await this.payments.getStripeConfig(schedule.organizationId);
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["setup_intent"] }, this.requestOptions(stripeAccount));
    } catch {
      throw new NotFoundException("Checkout session not found");
    }
    const paymentMethodId = verifySetupSession(session, schedule);
    if (!paymentMethodId) throw new BadRequestException("The card was not saved. Please try again.");
    return paymentMethodId;
  }

  /** Charges a freshly generated invoice to the schedule's saved card. Never throws. */
  async chargeInvoice(schedule: ScheduleForCharge, invoice: InvoiceForCharge): Promise<ChargeOutcome> {
    if (!schedule.autoCharge) return { status: "skipped", reason: "Automatic charging is off" };
    if (!schedule.stripeCustomerId || !schedule.stripePaymentMethodId) {
      return { status: "skipped", reason: "No card on file" };
    }
    if (!["sent", "overdue"].includes(invoice.status)) return { status: "skipped", reason: `Invoice is ${invoice.status}` };
    const amount = calculateInvoiceTotal(invoice);
    if (amount <= 0) return { status: "skipped", reason: "Invoice total is zero" };
    if (!(await this.isAvailable(schedule.organizationId))) {
      return { status: "skipped", reason: "Online payments are not configured" };
    }

    try {
      const { stripe, stripeAccount } = await this.payments.getStripeConfig(schedule.organizationId);
      const intent = await stripe.paymentIntents.create(
        {
          amount,
          currency: this.currency,
          customer: schedule.stripeCustomerId,
          payment_method: schedule.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          description: `Invoice ${invoice.invoiceNumber}`,
          metadata: { invoiceId: invoice.id, organizationId: schedule.organizationId, recurringInvoiceId: schedule.id },
        },
        // One charge per invoice even if a run is retried.
        { ...(stripeAccount ? { stripeAccount } : {}), idempotencyKey: `atrium-recurring-charge-${invoice.id}` },
      );
      if (intent.status === "succeeded") {
        await this.payments.recordStripePayment(invoice, intent.amount_received || amount, intent.id);
        return { status: "paid", paymentIntentId: intent.id };
      }
      if (intent.status === "processing") return { status: "pending", paymentIntentId: intent.id };
      return { status: "failed", reason: `Payment ${intent.status.replace(/_/g, " ")}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Automatic charge failed for invoice ${invoice.id}: ${message}`);
      return { status: "failed", reason: message.slice(0, 300) };
    }
  }
}

/** The saved payment method id when the session is a completed card setup for this schedule, else null. */
export function verifySetupSession(
  session: Pick<Stripe.Checkout.Session, "mode" | "status" | "metadata" | "customer" | "setup_intent">,
  schedule: { id: string; organizationId: string; stripeCustomerId: string | null },
): string | null {
  if (session.mode !== "setup" || session.status !== "complete") return null;
  if (session.metadata?.recurringInvoiceId !== schedule.id) return null;
  if (session.metadata?.organizationId !== schedule.organizationId) return null;
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!schedule.stripeCustomerId || customer !== schedule.stripeCustomerId) return null;
  const intent = session.setup_intent;
  if (!intent || typeof intent === "string" || intent.status !== "succeeded") return null;
  const pm = intent.payment_method;
  return (typeof pm === "string" ? pm : pm?.id) ?? null;
}
