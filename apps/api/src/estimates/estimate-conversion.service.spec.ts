import { describe, expect, it, mock } from "bun:test";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { InvoicesService } from "../invoices/invoices.service";
import type { ContactSyncService } from "../contact-sync/contact-sync.service";
import type { AttachmentStorageService, AuditService } from "../service-core";
import type { EstimatesService } from "./estimates.service";
import type { EstimatePdfService } from "./estimate-pdf.service";
import { EstimateConversionService } from "./estimate-conversion.service";

function accepted(over: Record<string, unknown> = {}) {
  return {
    id: "est-1",
    organizationId: "org-1",
    number: "EST-1001",
    version: 1,
    status: "accepted",
    title: "Office network",
    convertedAt: null,
    companyId: "co-1",
    recipientUserId: "client-1",
    projectId: null,
    acceptedById: "client-1",
    acceptedName: "Sample Client",
    signatureKey: "sig.png",
    respondedAt: new Date("2026-05-01T10:00:00Z"),
    sentAt: new Date("2026-04-28T10:00:00Z"),
    discountType: null,
    discountValue: null,
    depositPercent: 25,
    lineItems: [
      { name: "Setup", unit: "each", quantity: 1, unitPriceCents: 100000, costCents: null, taxable: true, taxRateBps: 1000, optional: false, selected: true, billingType: "fixed", recurringInterval: null, order: 0 },
      { name: "Monitoring", unit: "month", quantity: 1, unitPriceCents: 5000, costCents: null, taxable: true, taxRateBps: 1000, optional: false, selected: true, billingType: "recurring", recurringInterval: "monthly", order: 1 },
    ],
    ...over,
  };
}

function setup(e: Record<string, unknown> = accepted()) {
  const tx = {
    estimate: {
      updateMany: mock(() => Promise.resolve({ count: 1 })),
      update: mock(() => Promise.resolve({})),
    },
    project: {
      create: mock(() => Promise.resolve({ id: "proj-new" })),
      findFirst: mock((): Promise<unknown> => Promise.resolve({ id: "proj-1", archivedAt: null })),
    },
    projectClient: { upsert: mock(() => Promise.resolve({})) },
    recurringInvoice: { create: mock((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "rec-1", ...args.data })) },
    file: { create: mock(() => Promise.resolve({ id: "file-1" })) },
    document: { create: mock(() => Promise.resolve({ id: "doc-1" })) },
    documentResponse: { create: mock(() => Promise.resolve({})) },
    documentAuditEvent: { createMany: mock(() => Promise.resolve({})) },
    estimateEvent: {
      findFirst: mock(() => Promise.resolve({ ipAddress: "203.0.113.9", userAgent: "ua" })),
      create: mock(() => Promise.resolve({})),
    },
  };
  const prisma = {
    ...tx,
    $transaction: mock((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  let n = 0;
  const invoices = {
    createDraftInTx: mock((_tx: unknown, _org: string, data: Record<string, unknown>) => Promise.resolve({ id: `inv-${++n}`, ...data })),
  };
  const estimates = { findRaw: mock(() => Promise.resolve(e)) };
  const pdf = { render: mock(() => Promise.resolve(Buffer.from("%PDF-1.4"))) };
  const storage = { storeBuffer: mock(() => Promise.resolve("org-1/estimate-documents/x.pdf")), remove: mock(() => Promise.resolve()) };
  const audit = { record: mock(() => Promise.resolve()) };
  const contactSync = { linkProjectClients: mock(() => Promise.resolve()) };
  const service = new EstimateConversionService(
    prisma as unknown as PrismaService,
    estimates as unknown as EstimatesService,
    invoices as unknown as InvoicesService,
    pdf as unknown as EstimatePdfService,
    storage as unknown as AttachmentStorageService,
    audit as unknown as AuditService,
    contactSync as unknown as ContactSyncService,
  );
  return { tx, invoices, pdf, storage, audit, contactSync, service };
}

describe("EstimateConversionService", () => {
  it("creates a project, deposit + balance drafts, a paused schedule and the signed document", async () => {
    const { tx, invoices, pdf, audit, contactSync, service } = setup();
    const result = await service.convert("org-1", "est-1", "staff-1", { project: "create", invoices: "deposit" });
    expect(result).toEqual({
      estimateId: "est-1",
      projectId: "proj-new",
      invoiceIds: ["inv-1", "inv-2"],
      recurringInvoiceIds: ["rec-1"],
      documentId: "doc-1",
    });
    expect(pdf.render.mock.calls[0]).toEqual([expect.anything(), { withAcceptance: true }]);
    expect(tx.projectClient.upsert).toHaveBeenCalled();
    const firstInvoice = (invoices.createDraftInTx.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>])[2];
    expect(firstInvoice).toMatchObject({ projectId: "proj-new", estimateId: "est-1" });
    const schedule = (tx.recurringInvoice.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(schedule).toMatchObject({ status: "paused", interval: "monthly", companyId: "co-1", recipientUserId: "client-1", projectId: "proj-new" });
    const doc = (tx.document.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(doc).toMatchObject({ type: "quote", status: "accepted", fileId: "file-1", projectId: "proj-new" });
    const events = (tx.documentAuditEvent.createMany.mock.calls[0] as unknown as [{ data: Array<Record<string, unknown>> }])[0].data;
    expect(events.map((ev) => ev.action)).toEqual(["created", "accepted"]);
    expect(events[1]).toMatchObject({ userId: "client-1", ipAddress: "203.0.113.9" });
    expect(tx.estimate.update).toHaveBeenCalledWith({ where: { id: "est-1" }, data: { documentId: "doc-1", projectId: "proj-new" } });
    expect((audit.record.mock.calls[0] as unknown as [{ action: string }])[0].action).toBe("estimate.converted");
    expect(contactSync.linkProjectClients).toHaveBeenCalledWith("proj-new", "org-1", ["client-1"]);
  });

  it("refuses a second conversion", async () => {
    const { service } = setup(accepted({ status: "converted", convertedAt: new Date() }));
    await expect(service.convert("org-1", "est-1", "staff-1", { project: "create", invoices: "full" })).rejects.toThrow(ConflictException);
  });

  it("refuses when a concurrent conversion claimed it first, and removes the stored PDF", async () => {
    const { tx, storage, service } = setup();
    tx.estimate.updateMany.mockImplementationOnce(() => Promise.resolve({ count: 0 }));
    await expect(service.convert("org-1", "est-1", "staff-1", { project: "create", invoices: "full" })).rejects.toThrow(ConflictException);
    expect(storage.remove).toHaveBeenCalledWith("org-1/estimate-documents/x.pdf");
  });

  it("only converts accepted estimates", async () => {
    const { service } = setup(accepted({ status: "sent" }));
    await expect(service.convert("org-1", "est-1", "staff-1", { project: "create", invoices: "full" })).rejects.toThrow(BadRequestException);
  });

  it("validates milestone percentages before touching anything", async () => {
    const { storage, service } = setup();
    await expect(
      service.convert("org-1", "est-1", "staff-1", { project: "create", invoices: "milestones", milestones: [{ percent: 50 }, { percent: 30 }] }),
    ).rejects.toThrow(/100/);
    expect(storage.storeBuffer).not.toHaveBeenCalled();
  });

  it("uses an existing project from this workspace only", async () => {
    const { tx, service } = setup();
    tx.project.findFirst.mockImplementationOnce(() => Promise.resolve(null));
    await expect(
      service.convert("org-1", "est-1", "staff-1", { project: "existing", projectId: "proj-other", invoices: "full" }),
    ).rejects.toThrow(/Project not found/);
  });
});
