import { beforeEach, describe, expect, it, mock } from "bun:test";
import { RecurringGeneratorService } from "./recurring-generator.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../service-core";
import type { RecurringNotificationsService } from "./recurring-notifications.service";
import type { RecurringStripeService } from "./recurring-stripe.service";

const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

type Args = { data?: Record<string, unknown>; where?: Record<string, unknown> };

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: "sched-1",
    organizationId: "org-1",
    name: "Managed services",
    companyId: "co-1",
    recipientUserId: "user-1",
    projectId: null,
    interval: "monthly",
    intervalCount: 1,
    startDate: d("2026-03-15"),
    endDate: null as Date | null,
    nextRunAt: d("2026-03-15"),
    lastRunAt: null as Date | null,
    dueDays: 14,
    prorateFirst: true,
    autoSend: true,
    autoCharge: false,
    stripeCustomerId: null,
    stripePaymentMethodId: null,
    status: "active",
    notes: null,
    items: [
      { description: "Support plan", quantity: 1, unitPrice: 31_000, taxRateBps: 825, order: 0 },
      { description: "Backup seats", quantity: 5, unitPrice: 1_000, taxRateBps: 0, order: 1 },
    ],
    ...overrides,
  };
}

function setup(opts: { claimed: boolean; row?: ReturnType<typeof schedule> }) {
  const row = opts.row ?? schedule();
  const tx = {
    $queryRaw: mock(() => Promise.resolve(opts.claimed ? [{ id: row.id }] : [])),
    recurringInvoice: {
      findUnique: mock(() => Promise.resolve(row)),
      update: mock((args: Args) => Promise.resolve({ ...row, ...args.data })),
    },
    invoice: {
      findFirst: mock(() => Promise.resolve({ invoiceNumber: "INV-0041" })),
      create: mock((_args: Args) => Promise.resolve({ id: "inv-new" })),
    },
  };
  const prisma = {
    $transaction: mock((fn: (t: typeof tx) => unknown) => fn(tx)),
    recurringInvoice: {
      findMany: mock(() => Promise.resolve([{ id: row.id }])),
      findUnique: mock(() => Promise.resolve(row)),
    },
    invoice: {
      findUnique: mock(() => Promise.resolve({ id: "inv-new", invoiceNumber: "INV-0042", status: row.autoSend ? "sent" : "draft", type: "itemized", amount: null, lineItems: [] })),
    },
  };
  const audit = { record: mock(() => Promise.resolve()) };
  const notices = { invoiceSent: mock(() => Promise.resolve()), chargeFailed: mock(() => Promise.resolve()) };
  const stripe = { chargeInvoice: mock(() => Promise.resolve({ status: "skipped", reason: "off" })) };
  const service = new RecurringGeneratorService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    notices as unknown as RecurringNotificationsService,
    stripe as unknown as RecurringStripeService,
  );
  return { service, tx, prisma, audit, notices, stripe };
}

describe("RecurringGeneratorService", () => {
  let now: Date;
  beforeEach(() => {
    now = new Date("2026-03-15T09:00:00.000Z");
  });

  it("does nothing when another run holds the schedule", async () => {
    const { service, tx } = setup({ claimed: false });
    expect(await service.generate("sched-1", now, { force: false })).toBeNull();
    expect(tx.invoice.create).not.toHaveBeenCalled();
    expect(tx.recurringInvoice.update).not.toHaveBeenCalled();
  });

  it("claims with SKIP LOCKED and only due rows unless forced", async () => {
    const { service, tx } = setup({ claimed: false });
    await service.generate("sched-1", now, { force: false });
    const sql = (tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join("?");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'active'");
  });

  it("creates a prorated, itemized first invoice and advances to the boundary", async () => {
    const { service, tx, notices, audit } = setup({ claimed: true });
    const run = await service.generate("sched-1", now, { force: false });
    expect(run).toEqual({ scheduleId: "sched-1", invoiceId: "inv-new", invoiceNumber: "INV-0042", ended: false });

    const data = (tx.invoice.create.mock.calls[0][0] as Args).data as Record<string, any>;
    expect(data.status).toBe("sent");
    expect(data.recurringInvoiceId).toBe("sched-1");
    expect(data.organizationId).toBe("org-1");
    expect(data.invoiceNumber).toBe("INV-0042");
    const items = data.lineItems.create as Array<Record<string, unknown>>;
    // Mar 15 -> Apr 1 is 17 of March's 31 days.
    expect(items[0]).toMatchObject({ quantity: 1, unitPrice: 17_000, taxRateBps: 825 });
    expect(items[0].description).toContain("prorated");
    expect(items[1]).toMatchObject({ quantity: 5, unitPrice: 548, taxRateBps: 0 });
    expect((data.dueDate as Date).toISOString().slice(0, 10)).toBe("2026-03-29");

    const update = (tx.recurringInvoice.update.mock.calls[0][0] as Args).data as Record<string, any>;
    expect((update.nextRunAt as Date).toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(update.lastRunAt).toEqual(now);
    expect(update.status).toBeUndefined();

    expect(notices.invoiceSent).toHaveBeenCalledWith("inv-new");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "recurring_invoice.generated", targetId: "inv-new" }));
  });

  it("bills full periods after the first run and leaves drafts unsent", async () => {
    const row = schedule({ lastRunAt: d("2026-03-15"), nextRunAt: d("2026-04-01"), autoSend: false });
    const { service, tx, notices } = setup({ claimed: true, row });
    await service.generate("sched-1", new Date("2026-04-01T01:00:00Z"), { force: false });
    const data = (tx.invoice.create.mock.calls[0][0] as Args).data as Record<string, any>;
    expect(data.status).toBe("draft");
    expect(data.lineItems.create[0]).toMatchObject({ unitPrice: 31_000, description: "Support plan" });
    expect(notices.invoiceSent).not.toHaveBeenCalled();
  });

  it("ends the schedule once the next period starts after the end date", async () => {
    const row = schedule({ prorateFirst: false, startDate: d("2026-01-31"), lastRunAt: d("2026-01-31"), nextRunAt: d("2026-02-28"), endDate: d("2026-03-15") });
    const { service, tx } = setup({ claimed: true, row });
    const run = await service.generate("sched-1", new Date("2026-02-28T05:00:00Z"), { force: false });
    expect(run?.ended).toBe(true);
    const update = (tx.recurringInvoice.update.mock.calls[0][0] as Args).data as Record<string, any>;
    expect((update.nextRunAt as Date).toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(update.status).toBe("ended");
  });

  it("creates no invoice when the run date is past the end date", async () => {
    const row = schedule({ nextRunAt: d("2026-05-01"), lastRunAt: d("2026-04-01"), endDate: d("2026-04-30") });
    const { service, tx } = setup({ claimed: true, row });
    const run = await service.generate("sched-1", new Date("2026-05-01T05:00:00Z"), { force: false });
    expect(run).toEqual({ scheduleId: "sched-1", invoiceId: null, invoiceNumber: null, ended: true });
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it("retries when the invoice number was taken concurrently", async () => {
    const { service, prisma, tx } = setup({ claimed: true });
    let calls = 0;
    prisma.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) => {
      calls++;
      if (calls === 1) return Promise.reject(Object.assign(new Error("dup"), { code: "P2002" }));
      return fn(tx);
    }) as never);
    const run = await service.generate("sched-1", now, { force: true });
    expect(calls).toBe(2);
    expect(run?.invoiceId).toBe("inv-new");
  });

  it("records failed automatic charges and alerts staff", async () => {
    const { service, stripe, audit, notices } = setup({ claimed: true });
    stripe.chargeInvoice.mockImplementation((() => Promise.resolve({ status: "failed", reason: "card_declined" })) as never);
    await service.generate("sched-1", now, { force: false });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "recurring_invoice.charge_failed" }));
    expect(notices.chargeFailed).toHaveBeenCalledWith("org-1", "INV-0042", "card_declined");
  });
});
