import { beforeEach, describe, expect, it, mock } from "bun:test";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService, ServiceSettingsService } from "../service-core";
import type { TaxRatesService } from "../catalog/tax-rates.service";
import type { EstimateNotificationsService } from "./estimate-notifications.service";
import { EstimatesService } from "./estimates.service";

function est(over: Record<string, unknown> = {}) {
  return {
    id: "est-1",
    organizationId: "org-1",
    number: "EST-1001",
    version: 1,
    rootId: "est-1",
    status: "draft",
    title: "Office move",
    recipientUserId: "client-1",
    companyId: null,
    validUntil: new Date(Date.now() + 86_400_000),
    discountType: null,
    discountValue: null,
    depositPercent: null,
    lineItems: [{ quantity: 1, unitPriceCents: 1000, taxRateBps: 0, taxable: true, optional: false, selected: true, billingType: "fixed", order: 0 }],
    company: null,
    ...over,
  };
}

function setup(current: Record<string, unknown> = est()) {
  const prisma = {
    estimate: {
      findFirst: mock((): Promise<unknown> => Promise.resolve(current)),
      findMany: mock(() => Promise.resolve([])),
      findUniqueOrThrow: mock(() => Promise.resolve({ ...current, status: "sent" })),
      updateMany: mock(() => Promise.resolve({ count: 1 })),
      deleteMany: mock(() => Promise.resolve({ count: 1 })),
      create: mock((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "est-2", ...args.data })),
      update: mock(() => Promise.resolve({})),
    },
    estimateEvent: {
      create: mock(() => Promise.resolve({})),
      createMany: mock(() => Promise.resolve({})),
      findMany: mock(() => Promise.resolve([])),
    },
    estimateComment: { findMany: mock(() => Promise.resolve([])) },
    estimateLineItem: { deleteMany: mock(() => Promise.resolve({})) },
    invoice: { findMany: mock(() => Promise.resolve([])) },
    user: { findMany: mock(() => Promise.resolve([])) },
    member: { findFirst: mock((): Promise<unknown> => Promise.resolve({ role: "member" })) },
    contact: { findFirst: mock((): Promise<unknown> => Promise.resolve({ id: "contact-1", companyId: "co-1" })) },
    company: { findFirst: mock((): Promise<unknown> => Promise.resolve({ id: "co-1" })) },
    project: { findFirst: mock((): Promise<unknown> => Promise.resolve(null)) },
    ticket: { findFirst: mock((): Promise<unknown> => Promise.resolve(null)) },
    catalogItem: { findMany: mock(() => Promise.resolve([])) },
    $transaction: mock((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const settings = {
    get: mock(() => Promise.resolve({ estimateValidDays: 30, estimateDefaultTerms: "Net 14", aiAssistEnabled: false })),
    nextNumber: mock(() => Promise.resolve({ number: 1001, prefix: "EST" })),
    update: mock(() => Promise.resolve({})),
  };
  const audit = { record: mock(() => Promise.resolve()) };
  const taxRates = { defaultRateBps: mock(() => Promise.resolve(0)) };
  const notifications = { notifySent: mock(() => undefined), notifyStaffComment: mock(() => undefined) };
  const service = new EstimatesService(
    prisma as unknown as PrismaService,
    settings as unknown as ServiceSettingsService,
    audit as unknown as AuditService,
    taxRates as unknown as TaxRatesService,
    notifications as unknown as EstimateNotificationsService,
  );
  return { prisma, settings, audit, notifications, service };
}

const body = { title: "Office move", lineItems: [{ name: "Labour", billingType: "hourly", quantity: 1.5, unitPriceCents: 9000 }] };

describe("EstimatesService.create", () => {
  it("numbers the estimate from the workspace sequence and applies defaults", async () => {
    const { prisma, settings, service } = setup();
    await service.create("org-1", "staff-1", { ...body, recipientUserId: "client-1" });
    expect(settings.nextNumber).toHaveBeenCalledWith("org-1", "estimate", prisma);
    const data = (prisma.estimate.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.number).toBe("EST-1001");
    expect(data.terms).toBe("Net 14");
    expect(data.status).toBe("draft");
    // The recipient's company is used when none was picked.
    expect(data.companyId).toBe("co-1");
    expect(data.contactId).toBe("contact-1");
    expect((data.validUntil as Date).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("rejects a recipient who isn't a portal client", async () => {
    const { prisma, service } = setup();
    prisma.member.findFirst.mockImplementationOnce(() => Promise.resolve({ role: "admin" }));
    await expect(service.create("org-1", "staff-1", { ...body, recipientUserId: "staff-2" })).rejects.toThrow(BadRequestException);
  });

  it("rejects a recipient from another company", async () => {
    const { prisma, service } = setup();
    prisma.contact.findFirst.mockImplementationOnce(() => Promise.resolve({ id: "c", companyId: "co-other" }));
    await expect(
      service.create("org-1", "staff-1", { ...body, companyId: "co-1", recipientUserId: "client-1" }),
    ).rejects.toThrow(/not a contact of the selected company/);
  });

  it("rejects a company from another workspace", async () => {
    const { prisma, service } = setup();
    prisma.company.findFirst.mockImplementationOnce(() => Promise.resolve(null));
    await expect(service.create("org-1", "staff-1", { ...body, companyId: "co-x" })).rejects.toThrow(BadRequestException);
  });
});

describe("EstimatesService.send", () => {
  it("sends a draft, supersedes older versions, audits and notifies", async () => {
    const { prisma, audit, notifications, service } = setup(est({ version: 2, rootId: "est-0" }));
    await service.send("org-1", "est-1", "staff-1");
    const calls = prisma.estimate.updateMany.mock.calls as unknown as Array<[{ where: Record<string, unknown>; data: Record<string, unknown> }]>;
    expect(calls[0][0].data.status).toBe("sent");
    expect(calls[1][0].where).toMatchObject({ rootId: "est-0", version: { lt: 2 } });
    expect(calls[1][0].data).toEqual({ status: "superseded" });
    expect((audit.record.mock.calls[0] as unknown as [{ action: string }])[0].action).toBe("estimate.sent");
    expect(notifications.notifySent).toHaveBeenCalled();
  });

  it("can't send an estimate that is already sent", async () => {
    const { service } = setup(est({ status: "sent" }));
    await expect(service.send("org-1", "est-1", "staff-1")).rejects.toThrow(BadRequestException);
  });

  it("needs a recipient", async () => {
    const { service } = setup(est({ recipientUserId: null }));
    await expect(service.send("org-1", "est-1", "staff-1")).rejects.toThrow(/recipient/);
  });

  it("re-sends after the client asked for changes", async () => {
    const { service, notifications } = setup(est({ status: "changes_requested" }));
    await service.send("org-1", "est-1", "staff-1");
    expect(notifications.notifySent).toHaveBeenCalled();
  });

  it("reports a concurrent change instead of sending twice", async () => {
    const { prisma, service } = setup();
    prisma.estimate.updateMany.mockImplementationOnce(() => Promise.resolve({ count: 0 }));
    await expect(service.send("org-1", "est-1", "staff-1")).rejects.toThrow(ConflictException);
  });
});

describe("EstimatesService.revise and remove", () => {
  it("drafts version + 1 with the same number and root", async () => {
    const { prisma, service } = setup(est({ status: "changes_requested" }));
    prisma.estimate.findFirst
      .mockImplementationOnce(() => Promise.resolve(est({ status: "changes_requested" })))
      .mockImplementationOnce(() => Promise.resolve({ id: "est-1", version: 1, status: "changes_requested" }));
    await service.revise("org-1", "est-1", "staff-1");
    const data = (prisma.estimate.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ number: "EST-1001", version: 2, rootId: "est-1", status: "draft" });
  });

  it("only the latest version can be revised", async () => {
    const { prisma, service } = setup(est({ status: "sent" }));
    prisma.estimate.findFirst
      .mockImplementationOnce(() => Promise.resolve(est({ status: "sent" })))
      .mockImplementationOnce(() => Promise.resolve({ id: "est-9", version: 3, status: "draft" }));
    await expect(service.revise("org-1", "est-1", "staff-1")).rejects.toThrow(ConflictException);
  });

  it("can't revise an accepted estimate", async () => {
    const { service } = setup(est({ status: "accepted" }));
    await expect(service.revise("org-1", "est-1", "staff-1")).rejects.toThrow(BadRequestException);
  });

  it("deletes drafts only, with an audit entry", async () => {
    const { service, audit } = setup();
    await service.remove("org-1", "est-1", "staff-1");
    expect((audit.record.mock.calls[0] as unknown as [{ action: string }])[0].action).toBe("estimate.deleted");
    const sent = setup(est({ status: "sent" }));
    await expect(sent.service.remove("org-1", "est-1", "staff-1")).rejects.toThrow(BadRequestException);
  });

  it("edits drafts only", async () => {
    const { service } = setup(est({ status: "sent" }));
    await expect(service.update("org-1", "est-1", body)).rejects.toThrow(/Only draft/);
  });
});

describe("EstimatesService settings", () => {
  it("validates the prefix", async () => {
    const { service } = setup();
    await expect(service.updateSettings("org-1", { estimatePrefix: "E S T" })).rejects.toThrow(BadRequestException);
  });

  let ok: ReturnType<typeof setup>;
  beforeEach(() => {
    ok = setup();
  });
  it("uppercases the prefix", async () => {
    await ok.service.updateSettings("org-1", { estimatePrefix: "qt" });
    expect((ok.settings.update.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].estimatePrefix).toBe("QT");
  });
});
