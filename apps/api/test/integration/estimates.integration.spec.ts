import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { assertDisposableDatabase } from "./guard";
import { PrismaService } from "../../src/prisma/prisma.service";
import { ServiceSettingsService } from "../../src/service-core/service-settings.service";
import type { AttachmentStorageService } from "../../src/service-core/attachment-storage.service";
import type { AuditService } from "../../src/service-core/audit.service";
import { InvoicesService } from "../../src/invoices/invoices.service";
import type { NotificationsService } from "../../src/notifications/notifications.service";
import type { ContactSyncService } from "../../src/contact-sync/contact-sync.service";
import { TaxRatesService } from "../../src/catalog/tax-rates.service";
import { EstimatesService } from "../../src/estimates/estimates.service";
import { EstimatePdfService } from "../../src/estimates/estimate-pdf.service";
import { EstimateConversionService } from "../../src/estimates/estimate-conversion.service";
import type { EstimateNotificationsService } from "../../src/estimates/estimate-notifications.service";
import { calculateInvoiceTotal } from "../../src/payments/invoice-total";

let prisma: PrismaService;
let estimates: EstimatesService;
let conversion: EstimateConversionService;
let orgId: string;
let staffId: string;
let clientId: string;
let companyId: string;
const stored = new Map<string, Buffer>();
const removed: string[] = [];

const storage = {
  storeBuffer: async (buf: Buffer, org: string, folder: string, name: string): Promise<string> => {
    const key = `${org}/${folder}/${stored.size}-${name}`;
    stored.set(key, buf);
    return key;
  },
  remove: async (key: string): Promise<void> => {
    removed.push(key);
    stored.delete(key);
  },
  download: async () => {
    throw new Error("no signature in this test");
  },
} as unknown as AttachmentStorageService;

const audit = { record: async (): Promise<void> => undefined } as unknown as AuditService;
const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;

beforeAll(async () => {
  assertDisposableDatabase();
  prisma = new PrismaService();
  await prisma.$connect();
  const settings = new ServiceSettingsService(prisma);
  const notifications = { notifySent: () => undefined, notifyStaffComment: () => undefined } as unknown as EstimateNotificationsService;
  estimates = new EstimatesService(prisma, settings, audit, new TaxRatesService(prisma), notifications);
  const invoices = new InvoicesService(
    prisma,
    { notifyInvoiceSent: () => undefined } as unknown as NotificationsService,
    {} as unknown as ContactSyncService,
  );
  conversion = new EstimateConversionService(
    prisma,
    estimates,
    invoices,
    new EstimatePdfService(prisma, config, storage),
    storage,
    audit,
    { linkProjectClients: async (): Promise<void> => undefined } as unknown as ContactSyncService,
  );

  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({ data: { id: `est-org-${s}`, name: `Sample ${s}`, slug: `est-${s}` } })).id;
  staffId = (await prisma.user.create({ data: { id: `est-staff-${s}`, name: "Staff", email: `staff-${s}@example.com`, emailVerified: true } })).id;
  clientId = (await prisma.user.create({ data: { id: `est-client-${s}`, name: "Client", email: `client-${s}@example.com`, emailVerified: true } })).id;
  await prisma.member.createMany({
    data: [
      { id: `m1-${s}`, organizationId: orgId, userId: staffId, role: "owner" },
      { id: `m2-${s}`, organizationId: orgId, userId: clientId, role: "member" },
    ],
  });
  companyId = (await prisma.company.create({ data: { organizationId: orgId, name: "Sample Company" } })).id;
  await prisma.contact.create({ data: { organizationId: orgId, name: "Client", email: `client-${s}@example.com`, userId: clientId, companyId } });
});

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma?.user.deleteMany({ where: { id: { in: [staffId, clientId].filter(Boolean) } } });
  await prisma?.$disconnect();
});

const body = {
  title: "Office network",
  lineItems: [
    { name: "Switch install", billingType: "fixed", quantity: 2, unitPriceCents: 25000, taxRateBps: 1000 },
    { name: "Consulting", billingType: "hourly", quantity: 1.5, unitPriceCents: 10000, taxable: false },
    { name: "Optional rack", billingType: "fixed", quantity: 1, unitPriceCents: 9999, optional: true, selected: false },
    { name: "Monitoring", billingType: "recurring", recurringInterval: "monthly", quantity: 3, unitPriceCents: 2000, taxRateBps: 1000 },
  ],
};

async function acceptedEstimate(): Promise<string> {
  const e = await estimates.create(orgId, staffId, { ...body, recipientUserId: clientId, depositPercent: 40 });
  await estimates.send(orgId, e.id, staffId);
  await prisma.estimate.update({
    where: { id: e.id },
    data: { status: "accepted", acceptedById: clientId, acceptedName: "Client", respondedAt: new Date() },
  });
  await prisma.estimateEvent.create({ data: { estimateId: e.id, actorId: clientId, action: "accepted", ipAddress: "203.0.113.7" } });
  return e.id;
}

describe("estimate numbering", () => {
  it("allocates sequential numbers per workspace, also under concurrency", async () => {
    await estimates.getSettings(orgId);
    const created = await Promise.all(
      Array.from({ length: 5 }, () => estimates.create(orgId, staffId, { title: "Concurrent", lineItems: [] })),
    );
    const numbers = created.map((e) => Number(e.number.replace("EST-", ""))).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers[4] - numbers[0]).toBe(4);
  });

  it("keeps the number on revisions and supersedes the old version when the revision is sent", async () => {
    const e = await estimates.create(orgId, staffId, { ...body, recipientUserId: clientId });
    await estimates.send(orgId, e.id, staffId);
    const v2 = await estimates.revise(orgId, e.id, staffId);
    expect(v2.number).toBe(e.number);
    expect(v2.version).toBe(2);
    expect(v2.rootId).toBe(e.id);
    await estimates.send(orgId, v2.id, staffId);
    const v1 = await prisma.estimate.findUniqueOrThrow({ where: { id: e.id } });
    expect(v1.status).toBe("superseded");
  });
});

describe("invoice tax in SQL totals", () => {
  it("includes per-line tax in invoice stats", async () => {
    const svc = new InvoicesService(prisma, {} as unknown as NotificationsService, {} as unknown as ContactSyncService);
    const project = await prisma.project.create({ data: { organizationId: orgId, name: "Tax stats" } });
    await svc.create(
      {
        projectId: project.id,
        lineItems: [
          { description: "Taxed", quantity: 3, unitPrice: 3333, taxRateBps: 825 },
          { description: "Untaxed", quantity: 1, unitPrice: 1000 },
        ],
      },
      orgId,
    );
    const stats = await svc.getStats(orgId, project.id);
    expect(stats.totalAmount).toBe(9999 + 825 + 1000);
  });
});

describe("conversion", () => {
  it("creates the project, draft invoices with tax, a paused schedule and the signed document", async () => {
    const id = await acceptedEstimate();
    const detail = await estimates.get(orgId, id);
    const result = await conversion.convert(orgId, id, staffId, { project: "create", invoices: "deposit" });

    const project = await prisma.project.findUniqueOrThrow({ where: { id: result.projectId }, include: { clients: true } });
    expect(project.organizationId).toBe(orgId);
    expect(project.clients.map((c) => c.userId)).toEqual([clientId]);

    const invoices = await prisma.invoice.findMany({ where: { id: { in: result.invoiceIds } }, include: { lineItems: true } });
    expect(invoices).toHaveLength(2);
    expect(invoices.every((i) => i.status === "draft" && i.estimateId === id && i.projectId === result.projectId)).toBe(true);
    expect(invoices.some((i) => i.lineItems.some((l) => l.taxRateBps === 1000))).toBe(true);
    const sum = invoices.reduce((s, i) => s + calculateInvoiceTotal(i), 0);
    expect(Math.abs(sum - detail.totals.totalCents)).toBeLessThanOrEqual(1);

    const schedules = await prisma.recurringInvoice.findMany({ where: { id: { in: result.recurringInvoiceIds } }, include: { items: true } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ status: "paused", interval: "monthly", companyId, recipientUserId: clientId });
    expect(schedules[0].items[0]).toMatchObject({ quantity: 3, unitPrice: 2000, taxRateBps: 1000 });

    const doc = await prisma.document.findUniqueOrThrow({ where: { id: result.documentId }, include: { auditEvents: true, file: true, responses: true } });
    expect(doc).toMatchObject({ type: "quote", status: "accepted", projectId: result.projectId });
    expect(doc.auditEvents.map((ev) => ev.action).sort()).toEqual(["accepted", "created"]);
    expect(doc.responses[0]).toMatchObject({ userId: clientId, action: "accepted" });
    expect(stored.get(doc.file.storageKey!)?.subarray(0, 5).toString()).toBe("%PDF-");

    const after = await prisma.estimate.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: "converted", documentId: doc.id, projectId: result.projectId });
  });

  it("refuses to convert twice", async () => {
    const id = await acceptedEstimate();
    await conversion.convert(orgId, id, staffId, { project: "create", invoices: "full" });
    await expect(conversion.convert(orgId, id, staffId, { project: "create", invoices: "full" })).rejects.toThrow(/already converted/);
  });

  it("rolls everything back when a step fails", async () => {
    const id = await acceptedEstimate();
    const projectsBefore = await prisma.project.count({ where: { organizationId: orgId } });
    const invoicesBefore = await prisma.invoice.count({ where: { organizationId: orgId } });
    // An archived project makes the "existing project" path fail before anything is written,
    // so force a failure inside the transaction instead: a recipient that no longer exists.
    await prisma.estimate.update({ where: { id }, data: { recipientUserId: "missing-user" } });
    await expect(conversion.convert(orgId, id, staffId, { project: "create", invoices: "full" })).rejects.toThrow();
    expect(await prisma.project.count({ where: { organizationId: orgId } })).toBe(projectsBefore);
    expect(await prisma.invoice.count({ where: { organizationId: orgId } })).toBe(invoicesBefore);
    expect((await prisma.estimate.findUniqueOrThrow({ where: { id } })).status).toBe("accepted");
    expect(removed.length).toBeGreaterThan(0);
  });
});
