import { describe, expect, it, mock } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { RecurringInvoicesService, scheduleTotals } from "./recurring-invoices.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../service-core";
import type { RecurringGeneratorService } from "./recurring-generator.service";
import type { RecurringStripeService } from "./recurring-stripe.service";

const actor = { id: "owner-1", email: "owner@example.com" };

function setup(overrides: { member?: { role: string } | null; contact?: object | null; existing?: object | null; generated?: number } = {}) {
  const prisma = {
    company: { findFirst: mock(() => Promise.resolve({ id: "co-1" })) },
    project: { findFirst: mock(() => Promise.resolve({ id: "proj-1" })) },
    member: { findFirst: mock(() => Promise.resolve(overrides.member === undefined ? { role: "member" } : overrides.member)) },
    contact: { findFirst: mock(() => Promise.resolve(overrides.contact === undefined ? { id: "ct-1" } : overrides.contact)) },
    recurringInvoice: {
      create: mock((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "sched-1", ...args.data, lastRunAt: null, status: "active", items: [], stripeCustomerId: null, stripePaymentMethodId: null }),
      ),
      findFirst: mock(() => Promise.resolve(overrides.existing ?? null)),
      findMany: mock(() => Promise.resolve([])),
      update: mock((args: { data: Record<string, unknown> }) => Promise.resolve({ ...(overrides.existing ?? {}), ...args.data, items: [] })),
      delete: mock(() => Promise.resolve()),
    },
    recurringInvoiceItem: { deleteMany: mock(() => Promise.resolve()) },
    invoice: { count: mock(() => Promise.resolve(overrides.generated ?? 0)) },
    $transaction: mock((fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const audit = { record: mock(() => Promise.resolve()) };
  const service = new RecurringInvoicesService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    {} as RecurringGeneratorService,
    { isAvailable: mock(() => Promise.resolve(false)) } as unknown as RecurringStripeService,
  );
  return { service, prisma, audit };
}

const dto = {
  name: "Managed services",
  companyId: "co-1",
  recipientUserId: "user-1",
  interval: "monthly",
  startDate: "2026-03-15",
  items: [{ description: "Support", quantity: 1, unitPrice: 10_000, taxRateBps: 825 }],
};

describe("RecurringInvoicesService", () => {
  it("creates a schedule starting on its start date and audits it", async () => {
    const { service, prisma, audit } = setup();
    const result = await service.create(dto, "org-1", actor);
    const data = (prisma.recurringInvoice.create.mock.calls[0][0] as { data: Record<string, any> }).data;
    expect(data.organizationId).toBe("org-1");
    expect(data.nextRunAt.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(data.autoCharge).toBe(false);
    expect(data.items.create[0]).toMatchObject({ taxRateBps: 825, order: 0 });
    expect(result).not.toHaveProperty("stripeCustomerId");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "recurring_invoice.created", organizationId: "org-1" }));
  });

  it("requires the recipient to be a portal client of the company", async () => {
    await expect(setup({ member: { role: "admin" } }).service.create(dto, "org-1", actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup({ member: null }).service.create(dto, "org-1", actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup({ contact: null }).service.create(dto, "org-1", actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("requires a recipient or a project", async () => {
    const { service } = setup();
    await expect(service.create({ ...dto, recipientUserId: null }, "org-1", actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an end date before the start date", async () => {
    const { service } = setup();
    await expect(service.create({ ...dto, endDate: "2026-03-01" }, "org-1", actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("skips periods missed while paused when resuming", async () => {
    const existing = {
      id: "sched-1",
      organizationId: "org-1",
      name: "Plan",
      companyId: null,
      recipientUserId: "user-1",
      projectId: null,
      interval: "monthly",
      intervalCount: 1,
      startDate: new Date("2020-01-05T00:00:00Z"),
      endDate: null,
      nextRunAt: new Date("2020-02-05T00:00:00Z"),
      lastRunAt: new Date("2020-01-05T00:00:00Z"),
      prorateFirst: false,
      status: "paused",
    };
    const { service, prisma, audit } = setup({ existing });
    await service.update("sched-1", { status: "active" }, "org-1", actor);
    const data = (prisma.recurringInvoice.update.mock.calls[0][0] as { data: Record<string, any> }).data;
    expect(data.nextRunAt.getTime()).toBeGreaterThanOrEqual(Date.now() - 86_400_000);
    expect(data.nextRunAt.getUTCDate()).toBe(5);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "recurring_invoice.resumed" }));
  });

  it("refuses to delete a schedule that generated invoices", async () => {
    const { service, prisma } = setup({ existing: { id: "sched-1", name: "Plan" }, generated: 2 });
    await expect(service.remove("sched-1", "org-1", actor)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.recurringInvoice.delete).not.toHaveBeenCalled();
  });

  it("hides schedules of other workspaces", async () => {
    const { service } = setup({ existing: null });
    await expect(service.remove("sched-x", "org-1", actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("totals items including tax", () => {
    expect(scheduleTotals([{ quantity: 2, unitPrice: 5_000, taxRateBps: 825 }, { quantity: 1, unitPrice: 100, taxRateBps: 0 }])).toEqual({
      subtotalCents: 10_100,
      taxCents: 825,
      totalCents: 10_925,
    });
  });
});
