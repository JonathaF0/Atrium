import { describe, expect, it, mock } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import type Stripe from "stripe";
import { RecurringStripeService, verifySetupSession } from "./recurring-stripe.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { PaymentsService } from "../payments/payments.service";
import type { BillingService } from "../billing/billing.service";

const schedule = { id: "sched-1", organizationId: "org-1", stripeCustomerId: "cus_1" };

function session(overrides: Record<string, unknown> = {}) {
  return {
    mode: "setup",
    status: "complete",
    customer: "cus_1",
    metadata: { recurringInvoiceId: "sched-1", organizationId: "org-1" },
    setup_intent: { status: "succeeded", payment_method: "pm_1" },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

describe("verifySetupSession", () => {
  it("returns the payment method for a completed setup of this schedule", () => {
    expect(verifySetupSession(session(), schedule)).toBe("pm_1");
  });

  it("rejects sessions for another schedule, workspace or customer", () => {
    expect(verifySetupSession(session({ metadata: { recurringInvoiceId: "other", organizationId: "org-1" } }), schedule)).toBeNull();
    expect(verifySetupSession(session({ metadata: { recurringInvoiceId: "sched-1", organizationId: "org-2" } }), schedule)).toBeNull();
    expect(verifySetupSession(session({ customer: "cus_2" }), schedule)).toBeNull();
    expect(verifySetupSession(session(), { ...schedule, stripeCustomerId: null })).toBeNull();
  });

  it("rejects incomplete or non-setup sessions", () => {
    expect(verifySetupSession(session({ status: "open" }), schedule)).toBeNull();
    expect(verifySetupSession(session({ mode: "payment" }), schedule)).toBeNull();
    expect(verifySetupSession(session({ setup_intent: { status: "requires_action", payment_method: "pm_1" } }), schedule)).toBeNull();
  });
});

describe("RecurringStripeService.chargeInvoice", () => {
  const invoice = { id: "inv-1", invoiceNumber: "INV-0001", status: "sent", type: "itemized", amount: null, lineItems: [{ quantity: 2, unitPrice: 5_000 }] };
  const charging = { id: "sched-1", organizationId: "org-1", autoCharge: true, stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" };

  function setup(intent: Partial<Stripe.PaymentIntent> | Error, enabled = true) {
    const create = mock(() => (intent instanceof Error ? Promise.reject(intent) : Promise.resolve(intent)));
    const payments = {
      getPaymentStatus: mock(() => Promise.resolve({ enabled })),
      getStripeConfig: mock(() => Promise.resolve({ stripe: { paymentIntents: { create } }, stripeAccount: "acct_1" })),
      recordStripePayment: mock(() => Promise.resolve(true)),
    };
    const billing = { hasFeature: mock(() => Promise.resolve(true)) };
    const config = { get: (_k: string, fallback?: string) => fallback };
    const service = new RecurringStripeService(
      {} as PrismaService,
      payments as unknown as PaymentsService,
      billing as unknown as BillingService,
      config as unknown as ConfigService,
    );
    return { service, create, payments };
  }

  it("skips when charging is off or no card is saved", async () => {
    const { service, create } = setup({ id: "pi_1", status: "succeeded" });
    expect((await service.chargeInvoice({ ...charging, autoCharge: false }, invoice)).status).toBe("skipped");
    expect((await service.chargeInvoice({ ...charging, stripePaymentMethodId: null }, invoice)).status).toBe("skipped");
    expect(create).not.toHaveBeenCalled();
  });

  it("skips when the workspace has no online payments", async () => {
    const { service, create } = setup({ id: "pi_1", status: "succeeded" }, false);
    expect((await service.chargeInvoice(charging, invoice)).status).toBe("skipped");
    expect(create).not.toHaveBeenCalled();
  });

  it("charges off-session once per invoice and records the payment", async () => {
    const { service, create, payments } = setup({ id: "pi_1", status: "succeeded", amount_received: 10_000 });
    expect(await service.chargeInvoice(charging, invoice)).toEqual({ status: "paid", paymentIntentId: "pi_1" });
    const [params, opts] = create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(params).toMatchObject({ amount: 10_000, customer: "cus_1", payment_method: "pm_1", off_session: true, confirm: true });
    expect(opts).toEqual({ stripeAccount: "acct_1", idempotencyKey: "atrium-recurring-charge-inv-1" });
    expect(payments.recordStripePayment).toHaveBeenCalledWith(invoice, 10_000, "pi_1");
  });

  it("reports declines without throwing", async () => {
    const { service, payments } = setup(new Error("Your card was declined."));
    expect(await service.chargeInvoice(charging, invoice)).toEqual({ status: "failed", reason: "Your card was declined." });
    expect(payments.recordStripePayment).not.toHaveBeenCalled();
  });
});
