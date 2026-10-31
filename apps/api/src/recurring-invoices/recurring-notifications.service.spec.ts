import "../common/testing/mock-email";
import { describe, expect, it, mock } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { RecurringNotificationsService } from "./recurring-notifications.service";
import { fakeEmailRenderer } from "../common/testing/fake-email-renderer";
import type { PrismaService } from "../prisma/prisma.service";
import type { MailService } from "../mail/mail.service";
import type { InAppNotificationsService } from "../notifications/in-app-notifications.service";
import type { PushService } from "../notifications/push.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { IntegrationDispatcher } from "../integrations/integration-dispatcher.service";

const recipient = { id: "user-1", name: "Sample Client", email: "client@example.com" };

function setup(opts: { projectId?: string | null; projectClients?: (typeof recipient)[] } = {}) {
  const invoice = {
    id: "inv-1",
    invoiceNumber: "INV-0042",
    organizationId: "org-1",
    projectId: opts.projectId ?? null,
    recurringInvoiceId: "sched-1",
    dueDate: new Date("2026-10-08T12:00:00Z"),
    type: "itemized",
    amount: null,
    lineItems: [{ quantity: 1, unitPrice: 25_000 }],
  };
  const prisma = {
    invoice: { findUnique: mock(() => Promise.resolve(invoice)) },
    recurringInvoice: { findFirst: mock(() => Promise.resolve({ recipientUserId: "user-1" })) },
    member: { findFirst: mock(() => Promise.resolve({ user: recipient })), findMany: mock(() => Promise.resolve([{ userId: "owner-1" }])) },
    projectClient: { findMany: mock(() => Promise.resolve((opts.projectClients ?? []).map((user) => ({ user })))) },
  };
  const mail = { send: mock(() => Promise.resolve({ sent: true, viaOrgConfig: false })) };
  const inApp = { createMany: mock(() => Promise.resolve()) };
  const push = { sendToMany: mock(() => Promise.resolve()) };
  const notifications = { notifyInvoiceSent: mock(() => undefined) };
  const integrations = { dispatch: mock(() => undefined) };
  const service = new RecurringNotificationsService(
    prisma as unknown as PrismaService,
    { get: (_k: string, fallback?: string) => fallback } as unknown as ConfigService,
    mail as unknown as MailService,
    fakeEmailRenderer(),
    inApp as unknown as InAppNotificationsService,
    push as unknown as PushService,
    notifications as unknown as NotificationsService,
    integrations as unknown as IntegrationDispatcher,
  );
  return { service, mail, inApp, notifications, integrations };
}

describe("RecurringNotificationsService", () => {
  it("sends a project-less invoice to the schedule's recipient on top of the standard path", async () => {
    const { service, mail, notifications, inApp } = setup();
    await service.invoiceSent("inv-1");
    expect(notifications.notifyInvoiceSent).toHaveBeenCalledWith("inv-1");
    expect(mail.send).toHaveBeenCalledTimes(1);
    const [to, subject, html] = mail.send.mock.calls[0] as unknown as [string, string, string];
    expect(to).toBe("client@example.com");
    expect(subject).toContain("INV-0042");
    expect(html).toContain("/portal/billing");
    expect(inApp.createMany).toHaveBeenCalled();
  });

  it("does not email the recipient twice when they are already on the project", async () => {
    const { service, mail } = setup({ projectId: "proj-1", projectClients: [recipient] });
    await service.invoiceSent("inv-1");
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("sends overdue reminders and emits invoice.overdue", async () => {
    const { service, mail, integrations } = setup({ projectId: "proj-1", projectClients: [{ id: "user-2", name: "Other", email: "other@example.com" }] });
    expect(await service.overdueReminder("inv-1", 2, 7)).toBe(2);
    expect(mail.send.mock.calls.map((c) => (c as unknown as [string])[0]).sort()).toEqual(["client@example.com", "other@example.com"]);
    expect(integrations.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "invoice.overdue",
        organizationId: "org-1",
        projectId: "proj-1",
        data: expect.objectContaining({ invoiceNumber: "INV-0042", daysOverdue: 7, dunningStage: 2, recurringInvoiceId: "sched-1" }),
      }),
    );
  });
});
