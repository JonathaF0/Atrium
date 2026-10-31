import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InvoiceReminderEmail, InvoiceSentEmail } from "@atrium/email";
import { formatMoney } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { EmailRenderer } from "../mail/email-renderer";
import { InAppNotificationsService } from "../notifications/in-app-notifications.service";
import { PushService } from "../notifications/push.service";
import { NotificationsService } from "../notifications/notifications.service";
import { IntegrationDispatcher } from "../integrations/integration-dispatcher.service";
import { calculateInvoiceTotal } from "../payments/invoice-total";
import { getCurrency } from "../common/helpers/currency";

interface Recipient {
  id: string;
  name: string;
  email: string;
}

interface InvoiceForNotice {
  id: string;
  invoiceNumber: string;
  organizationId: string;
  projectId: string | null;
  recurringInvoiceId: string | null;
  dueDate: Date | null;
  type: string;
  amount: number | null;
  lineItems: Array<{ quantity: number; unitPrice: number }>;
}

function formatDay(date: Date | null): string {
  if (!date) return "upon receipt";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** Client and staff notices for schedule-generated invoices and overdue reminders. */
@Injectable()
export class RecurringNotificationsService {
  private readonly logger = new Logger(RecurringNotificationsService.name);
  private readonly webUrl: string;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private mail: MailService,
    private renderer: EmailRenderer,
    private inApp: InAppNotificationsService,
    private push: PushService,
    private notifications: NotificationsService,
    private integrations: IntegrationDispatcher,
  ) {
    this.webUrl = this.config.get<string>("WEB_URL", "http://localhost:3000").replace(/\/+$/, "");
  }

  /** Where a client opens the invoice: its project's invoices tab, or the portal billing page. */
  portalPath(invoice: { projectId: string | null }): string {
    return invoice.projectId ? `/portal/projects/${invoice.projectId}?tab=invoices` : "/portal/billing";
  }

  private async projectClients(projectId: string | null): Promise<Recipient[]> {
    if (!projectId) return [];
    const rows = await this.prisma.projectClient.findMany({
      where: { projectId },
      select: { user: { select: { id: true, name: true, email: true } } },
    });
    return rows.map((r) => r.user);
  }

  /** The schedule's recipient, when they are still a member of the workspace. */
  private async scheduleRecipient(invoice: InvoiceForNotice): Promise<Recipient | null> {
    if (!invoice.recurringInvoiceId) return null;
    const schedule = await this.prisma.recurringInvoice.findFirst({
      where: { id: invoice.recurringInvoiceId, organizationId: invoice.organizationId },
      select: { recipientUserId: true },
    });
    if (!schedule?.recipientUserId) return null;
    const member = await this.prisma.member.findFirst({
      where: { organizationId: invoice.organizationId, userId: schedule.recipientUserId },
      select: { user: { select: { id: true, name: true, email: true } } },
    });
    return member?.user ?? null;
  }

  /** Everyone an invoice is addressed to: its project's clients plus the schedule recipient. */
  async recipients(invoice: InvoiceForNotice): Promise<Recipient[]> {
    const [clients, recipient] = await Promise.all([
      this.projectClients(invoice.projectId),
      this.scheduleRecipient(invoice),
    ]);
    const all = recipient && !clients.some((c) => c.id === recipient.id) ? [...clients, recipient] : clients;
    return all;
  }

  private notifyInApp(userIds: string[], organizationId: string, type: string, title: string, message: string, link: string): void {
    if (userIds.length === 0) return;
    this.inApp
      .createMany(userIds.map((userId) => ({ userId, organizationId, type, title, message, link })))
      .catch((err) => this.logger.warn(`Failed to create in-app notifications: ${String(err)}`));
    this.push
      .sendToMany(userIds, organizationId, { title, message, link })
      .catch((err) => this.logger.warn(`Failed to send push notifications: ${String(err)}`));
  }

  private loadInvoice(invoiceId: string): Promise<InvoiceForNotice | null> {
    return this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        organizationId: true,
        projectId: true,
        recurringInvoiceId: true,
        dueDate: true,
        type: true,
        amount: true,
        lineItems: { select: { quantity: true, unitPrice: true } },
      },
    });
  }

  /**
   * The standard "invoice sent" path (integrations + project clients), plus the
   * schedule recipient when they are not already one of the project's clients.
   */
  async invoiceSent(invoiceId: string): Promise<void> {
    this.notifications.notifyInvoiceSent(invoiceId);
    const invoice = await this.loadInvoice(invoiceId);
    if (!invoice) return;
    const recipient = await this.scheduleRecipient(invoice);
    if (!recipient) return;
    const clients = await this.projectClients(invoice.projectId);
    if (clients.some((c) => c.id === recipient.id)) return;

    const amount = formatMoney(calculateInvoiceTotal(invoice), getCurrency(this.config));
    const dueDate = formatDay(invoice.dueDate);
    const link = this.portalPath(invoice);
    this.notifyInApp([recipient.id], invoice.organizationId, "invoice_sent", `Invoice ${invoice.invoiceNumber}`, `${amount} due ${dueDate}`, link);
    try {
      const html = await this.renderer.render(
        InvoiceSentEmail({
          clientName: recipient.name,
          invoiceNumber: invoice.invoiceNumber,
          amount,
          dueDate,
          portalUrl: `${this.webUrl}${link}`,
        }),
      );
      await this.mail.send(recipient.email, `Invoice ${invoice.invoiceNumber} — ${amount}`, html, invoice.organizationId);
    } catch (err) {
      this.logger.warn(`Failed to email invoice ${invoice.invoiceNumber} to its recipient: ${String(err)}`);
    }
  }

  /** Overdue reminder to the invoice's recipients, plus the `invoice.overdue` integration event. */
  async overdueReminder(invoiceId: string, stage: number, daysOverdue: number): Promise<number> {
    const invoice = await this.loadInvoice(invoiceId);
    if (!invoice) return 0;
    const amount = formatMoney(calculateInvoiceTotal(invoice), getCurrency(this.config));
    const dueDate = formatDay(invoice.dueDate);

    this.integrations.dispatch({
      event: "invoice.overdue",
      organizationId: invoice.organizationId,
      projectId: invoice.projectId,
      actorName: "Atrium",
      title: `Invoice ${invoice.invoiceNumber} is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`,
      detail: `${amount} was due ${dueDate}. Reminder ${stage} sent to the client.`,
      data: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        amountCents: calculateInvoiceTotal(invoice),
        dueDate: invoice.dueDate?.toISOString() ?? null,
        daysOverdue,
        dunningStage: stage,
        recurringInvoiceId: invoice.recurringInvoiceId,
      },
      path: invoice.projectId ? `/dashboard/projects/${invoice.projectId}?tab=invoices` : "/dashboard/invoices/recurring",
    });

    const recipients = await this.recipients(invoice);
    const link = this.portalPath(invoice);
    this.notifyInApp(
      recipients.map((r) => r.id),
      invoice.organizationId,
      "invoice_overdue",
      `Invoice ${invoice.invoiceNumber} is overdue`,
      `${amount} was due ${dueDate}`,
      link,
    );

    let sent = 0;
    for (const r of recipients) {
      try {
        const html = await this.renderer.render(
          InvoiceReminderEmail({
            clientName: r.name,
            invoiceNumber: invoice.invoiceNumber,
            amount,
            dueDate,
            daysOverdue,
            reminderNumber: stage,
            portalUrl: `${this.webUrl}${link}`,
          }),
        );
        await this.mail.send(r.email, `Reminder: invoice ${invoice.invoiceNumber} is overdue`, html, invoice.organizationId);
        sent++;
      } catch (err) {
        this.logger.warn(`Failed to send overdue reminder for ${invoice.invoiceNumber}: ${String(err)}`);
      }
    }
    return sent;
  }

  /** Tells owners/admins an automatic card charge did not go through. */
  async chargeFailed(organizationId: string, invoiceNumber: string, reason: string): Promise<void> {
    const admins = await this.prisma.member.findMany({
      where: { organizationId, role: { in: ["owner", "admin"] } },
      select: { userId: true },
    });
    this.notifyInApp(
      admins.map((a) => a.userId),
      organizationId,
      "recurring_charge_failed",
      `Automatic charge failed for ${invoiceNumber}`,
      reason.slice(0, 200),
      "/dashboard/invoices/recurring",
    );
  }
}
