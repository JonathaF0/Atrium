/**
 * The recurring-invoice cron claims a schedule with FOR UPDATE SKIP LOCKED and
 * advances nextRunAt in the same transaction as the invoice insert. Mocks can
 * only show the SQL is issued; this proves against Postgres that concurrent
 * runs (two replicas, or "run now" racing the cron) bill a period once.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { assertDisposableDatabase } from "./guard";
import { PrismaService } from "../../src/prisma/prisma.service";
import { RecurringGeneratorService } from "../../src/recurring-invoices/recurring-generator.service";
import type { AuditService } from "../../src/service-core";
import type { RecurringNotificationsService } from "../../src/recurring-invoices/recurring-notifications.service";
import type { RecurringStripeService } from "../../src/recurring-invoices/recurring-stripe.service";

let prismaA: PrismaService;
let prismaB: PrismaService;
let orgId: string;

function generator(prisma: PrismaService): RecurringGeneratorService {
  return new RecurringGeneratorService(
    prisma,
    { record: async () => undefined } as unknown as AuditService,
    { invoiceSent: async () => undefined, chargeFailed: async () => undefined } as unknown as RecurringNotificationsService,
    { chargeInvoice: async () => ({ status: "skipped", reason: "test" }) } as unknown as RecurringStripeService,
  );
}

async function createSchedule(nextRunAt: Date, overrides: Record<string, unknown> = {}): Promise<string> {
  const schedule = await prismaA.recurringInvoice.create({
    data: {
      organizationId: orgId,
      name: "Managed services",
      interval: "monthly",
      startDate: nextRunAt,
      nextRunAt,
      autoSend: false,
      items: { create: [{ description: "Support plan", quantity: 1, unitPrice: 50_000, taxRateBps: 825 }] },
      ...overrides,
    },
  });
  return schedule.id;
}

beforeAll(async () => {
  assertDisposableDatabase();
  prismaA = new PrismaService();
  prismaB = new PrismaService();
  await Promise.all([prismaA.$connect(), prismaB.$connect()]);
});

beforeEach(async () => {
  await prismaA.invoice.deleteMany({ where: {} });
  await prismaA.recurringInvoice.deleteMany({ where: {} });
  await prismaA.organization.deleteMany({ where: { id: { startsWith: "ri-org-" } } });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const org = await prismaA.organization.create({ data: { id: `ri-org-${stamp}`, name: "Sample Org", slug: `ri-${stamp}` } });
  orgId = org.id;
});

afterAll(async () => {
  await prismaA?.$disconnect();
  await prismaB?.$disconnect();
});

describe("recurring invoice generation", () => {
  it("bills a due period once when two runs race", async () => {
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const id = await createSchedule(today);
    const now = new Date();

    const [a, b] = await Promise.all([generator(prismaA).runDue(now), generator(prismaB).runDue(now)]);

    expect(a + b).toBe(1);
    const invoices = await prismaA.invoice.findMany({ where: { recurringInvoiceId: id }, include: { lineItems: true } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].lineItems[0]).toMatchObject({ unitPrice: 50_000, taxRateBps: 825 });
    const schedule = await prismaA.recurringInvoice.findUniqueOrThrow({ where: { id } });
    expect(schedule.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect(schedule.lastRunAt).not.toBeNull();
  });

  it("run now racing the cron produces one invoice per period", async () => {
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const id = await createSchedule(today);
    const now = new Date();

    const results = await Promise.all([
      generator(prismaA).generate(id, now, { force: false }),
      generator(prismaB).generate(id, now, { force: false }),
    ]);

    expect(results.filter((r) => r?.invoiceId)).toHaveLength(1);
    expect(await prismaA.invoice.count({ where: { recurringInvoiceId: id } })).toBe(1);
  });

  it("gives concurrent schedules distinct invoice numbers", async () => {
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const ids = await Promise.all([createSchedule(today), createSchedule(today), createSchedule(today)]);
    const now = new Date();

    await Promise.all(ids.map((id, i) => generator(i % 2 ? prismaA : prismaB).generate(id, now, { force: false })));

    const numbers = (await prismaA.invoice.findMany({ where: { organizationId: orgId }, select: { invoiceNumber: true } })).map((i) => i.invoiceNumber);
    expect(numbers).toHaveLength(3);
    expect(new Set(numbers).size).toBe(3);
  });

  it("catches up on missed periods and stops at the end date", async () => {
    const start = new Date(Date.UTC(2026, 0, 31));
    const id = await createSchedule(start, { endDate: new Date(Date.UTC(2026, 3, 15)) });

    const created = await generator(prismaA).runDue(new Date(Date.UTC(2026, 6, 1)));

    expect(created).toBe(3); // Jan 31, Feb 28, Mar 31; the Apr 30 run is past the end date
    const schedule = await prismaA.recurringInvoice.findUniqueOrThrow({ where: { id } });
    expect(schedule.status).toBe("ended");
    expect(schedule.nextRunAt.toISOString().slice(0, 10)).toBe("2026-04-30");
  });
});
