import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Test } from "@nestjs/testing";
import { computeEstimateTotals } from "@atrium/shared";
import { assertDisposableDatabase } from "./guard";
import { PrismaService } from "../../src/prisma/prisma.service";
import { ReportContextService } from "../../src/reports/report-context.service";
import type { ReportContext } from "../../src/reports/report-context.service";
import { TicketReportsService } from "../../src/reports/ticket-reports.service";
import { HoursReportService } from "../../src/reports/hours-report.service";
import { RevenueReportService } from "../../src/reports/revenue-report.service";
import { contractAllowanceMinutes, invoiceTotalCents, percentileCont } from "../../src/reports/report-math";
import { invoiceTotalSql } from "../../src/reports/report-math";

let prisma: PrismaService;
let contexts: ReportContextService;
let tickets: TicketReportsService;
let hoursSvc: HoursReportService;
let revenueSvc: RevenueReportService;

const NOW = new Date("2026-06-30T12:00:00Z");
const RANGE = { from: "2026-06-01", to: "2026-06-30" };
const TZ = "America/New_York";
const H = 3600_000;
const at = (iso: string): Date => new Date(iso);
const plus = (d: Date, hours: number): Date => new Date(d.getTime() + hours * H);

const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const orgA = `rpt-a-${s}`;
const orgB = `rpt-b-${s}`;
const userIds: string[] = [];

interface Ids {
  companyA: string;
  companyB: string;
  agent: string;
  t1: string;
  t2: string;
  t3: string;
  contractA: string;
}
let ids: Ids;

let ticketNo = 1000;
let invNo = 0;

async function ticket(orgId: string, data: Record<string, unknown>): Promise<string> {
  ticketNo += 1;
  const t = await prisma.ticket.create({
    data: {
      organizationId: orgId,
      number: ticketNo,
      subject: `Sample ticket ${ticketNo}`,
      emailToken: `tok-${s}-${ticketNo}`,
      ...data,
    } as never,
  });
  return t.id;
}

async function seedOrg(orgId: string, timezone: string | null): Promise<{ project: string; projectNoCompany: string; company: string; companyOther: string; user: string }> {
  await prisma.organization.create({ data: { id: orgId, name: `Org ${orgId}`, slug: orgId } });
  if (timezone) await prisma.systemSettings.create({ data: { organizationId: orgId, timezone } });
  const user = await prisma.user.create({ data: { id: `u-${orgId}`, name: "Agent One", email: `agent-${orgId}@example.com` } });
  userIds.push(user.id);
  const company = await prisma.company.create({ data: { organizationId: orgId, name: "Sample Company A" } });
  const companyOther = await prisma.company.create({ data: { organizationId: orgId, name: "Sample Company B" } });
  const contact = await prisma.contact.create({
    data: { organizationId: orgId, name: "Client A", email: `client-${orgId}@example.com`, companyId: company.id },
  });
  const project = await prisma.project.create({ data: { organizationId: orgId, name: "Managed services" } });
  const projectNoCompany = await prisma.project.create({ data: { organizationId: orgId, name: "Internal" } });
  await prisma.projectContact.create({ data: { projectId: project.id, contactId: contact.id } });
  return { project: project.id, projectNoCompany: projectNoCompany.id, company: company.id, companyOther: companyOther.id, user: user.id };
}

async function ctx(orgId: string, extra: Record<string, string> = {}): Promise<ReportContext> {
  return contexts.resolve(orgId, { ...RANGE, ...extra }, NOW);
}

beforeAll(async () => {
  assertDisposableDatabase();
  const mod = await Test.createTestingModule({
    providers: [PrismaService, ReportContextService, TicketReportsService, HoursReportService, RevenueReportService],
  }).compile();
  prisma = mod.get(PrismaService);
  contexts = mod.get(ReportContextService);
  tickets = mod.get(TicketReportsService);
  hoursSvc = mod.get(HoursReportService);
  revenueSvc = mod.get(RevenueReportService);

  const a = await seedOrg(orgA, TZ);
  const b = await seedOrg(orgB, null);
  const hardware = await prisma.ticketCategory.create({ data: { organizationId: orgA, name: "Hardware" } });

  // ─── Tickets (org A) ───
  const c1 = at("2026-06-05T10:00:00Z");
  const t1 = await ticket(orgA, {
    createdAt: c1, priority: "high", source: "portal", companyId: a.company, categoryId: hardware.id, assigneeId: a.user,
    status: "resolved", firstRespondedAt: plus(c1, 2), resolvedAt: plus(c1, 10),
    firstResponseDueAt: plus(c1, 4), resolutionDueAt: plus(c1, 16),
    csatRating: 5, csatComment: "Great help", csatAt: plus(c1, 11),
  });
  // 02:00 UTC on the 10th is the evening of the 9th in New York.
  const c2 = at("2026-06-10T02:00:00Z");
  const t2 = await ticket(orgA, {
    createdAt: c2, priority: "normal", source: "email", companyId: a.companyOther, assigneeId: a.user,
    status: "closed", firstRespondedAt: plus(c2, 6), resolvedAt: plus(c2, 30), closedAt: plus(c2, 30),
    firstResponseDueAt: plus(c2, 4), resolutionDueAt: plus(c2, 40), firstResponseBreached: true,
    csatRating: 3, csatAt: plus(c2, 31),
  });
  const c3 = at("2026-06-20T09:00:00Z");
  const t3 = await ticket(orgA, {
    createdAt: c3, priority: "urgent", companyId: a.company, status: "open",
    firstResponseDueAt: plus(c3, 1), resolutionDueAt: plus(c3, 24),
  });
  const c4 = at("2026-06-25T09:00:00Z");
  await ticket(orgA, {
    createdAt: c4, priority: "low", companyId: a.company, status: "on_hold", slaPausedAt: plus(c4, 2),
    firstRespondedAt: plus(c4, 1), firstResponseDueAt: plus(c4, 8), resolutionDueAt: plus(c4, 24),
  });
  // Created before the range, resolved inside it; never rated.
  await ticket(orgA, {
    createdAt: at("2026-05-20T09:00:00Z"), priority: "normal", companyId: a.company,
    status: "resolved", resolvedAt: at("2026-06-02T15:00:00Z"),
  });
  // Merged duplicates and tickets after the range are not counted.
  await ticket(orgA, { createdAt: at("2026-06-06T09:00:00Z"), mergedIntoId: t1, status: "closed", closedAt: at("2026-06-06T10:00:00Z") });
  await ticket(orgA, { createdAt: at("2026-07-05T09:00:00Z") });
  // Another workspace's ticket in the same range.
  await ticket(orgB, {
    createdAt: at("2026-06-12T09:00:00Z"), priority: "urgent", companyId: b.company, status: "resolved",
    resolvedAt: at("2026-06-12T10:00:00Z"), firstRespondedAt: at("2026-06-12T09:30:00Z"),
    firstResponseDueAt: at("2026-06-12T09:10:00Z"), firstResponseBreached: true, csatRating: 1, csatComment: "Other org",
  });

  // ─── Contracts and time (org A) ───
  const contractA = await prisma.contract.create({
    data: {
      organizationId: orgA, companyId: a.company, name: "Support plan", status: "active",
      startsAt: at("2026-01-01T00:00:00Z"), coveredMinutes: 600, coveragePeriod: "monthly",
    },
  });
  await prisma.contract.create({
    data: {
      organizationId: orgA, companyId: a.companyOther, name: "Quarterly block", status: "active",
      startsAt: at("2026-01-01T00:00:00Z"), coveredMinutes: 900, coveragePeriod: "quarterly",
    },
  });
  await prisma.contract.create({
    data: {
      organizationId: orgA, companyId: a.companyOther, name: "Cancelled plan", status: "cancelled",
      startsAt: at("2026-01-01T00:00:00Z"), coveredMinutes: 6000, coveragePeriod: "monthly",
    },
  });
  const invoicedLine = await prisma.invoice.create({
    data: {
      organizationId: orgA, invoiceNumber: `T-${s}-${invNo++}`, status: "draft",
      lineItems: { create: [{ description: "Time", quantity: 1, unitPrice: 100 }] },
    },
    include: { lineItems: true },
  });
  const entry = (orgId: string, data: Record<string, unknown>): Promise<unknown> =>
    prisma.timeEntry.create({ data: { organizationId: orgId, userId: orgId === orgA ? a.user : b.user, ...data } as never });
  await entry(orgA, { projectId: a.project, startedAt: at("2026-06-03T14:00:00Z"), durationSec: 7200, billable: true });
  await entry(orgA, {
    projectId: a.project, startedAt: at("2026-06-04T14:00:00Z"), durationSec: 3600, billable: true,
    invoiceLineItemId: invoicedLine.lineItems[0].id,
  });
  await entry(orgA, { projectId: a.project, ticketId: t3, startedAt: at("2026-06-20T14:00:00Z"), durationSec: 5400, billable: false });
  await entry(orgA, {
    projectId: a.projectNoCompany, contractId: contractA.id, startedAt: at("2026-06-21T14:00:00Z"), durationSec: 39600, billable: false,
  });
  await entry(orgA, { projectId: a.projectNoCompany, startedAt: at("2026-06-22T14:00:00Z"), durationSec: 3600, billable: true });
  await entry(orgA, { projectId: a.project, startedAt: at("2026-05-22T14:00:00Z"), durationSec: 99999, billable: true });
  await entry(orgB, { projectId: b.project, startedAt: at("2026-06-03T14:00:00Z"), durationSec: 7200, billable: true });

  // ─── Invoices, schedules and estimates ───
  const riB = await prisma.recurringInvoice.create({
    data: {
      organizationId: orgA, name: "Monthly support", companyId: a.companyOther, interval: "monthly", intervalCount: 1,
      startDate: at("2026-01-01T00:00:00Z"), nextRunAt: at("2026-07-01T00:00:00Z"),
      items: { create: [{ description: "Support", quantity: 1, unitPrice: 50000 }] },
    },
  });
  await prisma.recurringInvoice.create({
    data: {
      organizationId: orgA, name: "Annual licence", companyId: a.company, interval: "yearly", intervalCount: 1,
      startDate: at("2026-01-01T00:00:00Z"), nextRunAt: at("2027-01-01T00:00:00Z"),
      items: { create: [{ description: "Licence", quantity: 1, unitPrice: 120000, taxRateBps: 1000 }] },
    },
  });
  await prisma.recurringInvoice.create({
    data: {
      organizationId: orgA, name: "Fortnightly check", companyId: a.company, interval: "weekly", intervalCount: 2,
      startDate: at("2026-01-01T00:00:00Z"), nextRunAt: at("2026-07-01T00:00:00Z"),
      items: { create: [{ description: "Check", quantity: 1, unitPrice: 1200 }] },
    },
  });
  await prisma.recurringInvoice.create({
    data: {
      organizationId: orgA, name: "Paused plan", companyId: a.company, interval: "monthly", status: "paused",
      startDate: at("2026-01-01T00:00:00Z"), nextRunAt: at("2026-07-01T00:00:00Z"),
      items: { create: [{ description: "Paused", quantity: 1, unitPrice: 99900 }] },
    },
  });
  await prisma.recurringInvoice.create({
    data: {
      organizationId: orgB, name: "Other org", interval: "monthly", startDate: at("2026-01-01T00:00:00Z"),
      nextRunAt: at("2026-07-01T00:00:00Z"), items: { create: [{ description: "X", quantity: 1, unitPrice: 77700 }] },
    },
  });

  const inv = (orgId: string, data: Record<string, unknown>): Promise<unknown> =>
    prisma.invoice.create({ data: { organizationId: orgId, invoiceNumber: `INV-${s}-${invNo++}`, ...data } as never });
  await inv(orgA, {
    projectId: a.project, status: "paid", createdAt: at("2026-06-03T15:00:00Z"), paidAt: at("2026-06-15T15:00:00Z"),
    lineItems: { create: [
      { description: "Labour", quantity: 2, unitPrice: 10000, taxRateBps: 825 },
      { description: "Parts", quantity: 1, unitPrice: 5000 },
    ] },
  });
  await inv(orgA, {
    projectId: a.project, type: "uploaded", amount: 100000, status: "sent",
    createdAt: at("2026-06-10T15:00:00Z"), dueDate: at("2026-06-20T12:00:00Z"),
  });
  await inv(orgA, {
    recurringInvoiceId: riB.id, type: "uploaded", amount: 50000, status: "overdue",
    createdAt: at("2026-04-01T15:00:00Z"), dueDate: at("2026-04-15T12:00:00Z"),
  });
  await inv(orgA, { projectId: a.project, type: "uploaded", amount: 777, status: "draft", createdAt: at("2026-06-11T15:00:00Z") });
  await inv(orgA, {
    projectId: a.project, type: "uploaded", amount: 4000, status: "paid",
    createdAt: at("2026-05-02T15:00:00Z"), paidAt: at("2026-05-10T15:00:00Z"),
  });
  await inv(orgA, {
    projectId: a.project, status: "sent", createdAt: at("2026-06-12T15:00:00Z"), dueDate: at("2026-07-10T12:00:00Z"),
    lineItems: { create: [{ description: "Visit", quantity: 1, unitPrice: 1000, taxRateBps: 1000 }] },
  });
  await inv(orgB, {
    projectId: b.project, type: "uploaded", amount: 888888, status: "paid",
    createdAt: at("2026-06-05T15:00:00Z"), paidAt: at("2026-06-06T15:00:00Z"),
  });
  await inv(orgB, {
    projectId: b.project, type: "uploaded", amount: 333333, status: "overdue",
    createdAt: at("2026-03-05T15:00:00Z"), dueDate: at("2026-03-10T12:00:00Z"),
  });

  let estNo = 0;
  const est = (orgId: string, data: Record<string, unknown>): Promise<unknown> =>
    prisma.estimate.create({ data: { organizationId: orgId, number: `EST-${estNo++}`, title: "Sample estimate", ...data } as never });
  await est(orgA, {
    status: "sent", companyId: a.company, sentAt: at("2026-06-05T15:00:00Z"), discountType: "percent", discountValue: 1000,
    lineItems: { create: [
      { name: "Setup", quantity: 1, unitPriceCents: 10000, taxRateBps: 1000 },
      { name: "Optional extra", quantity: 1, unitPriceCents: 5000, optional: true, selected: false },
      { name: "Monitoring", quantity: 1, unitPriceCents: 2000, billingType: "recurring" },
    ] },
  });
  await est(orgA, { status: "viewed", sentAt: at("2026-06-06T15:00:00Z") });
  await est(orgA, { status: "accepted", sentAt: at("2026-06-08T15:00:00Z") });
  await est(orgA, { status: "declined", sentAt: at("2026-06-09T15:00:00Z") });
  await est(orgA, { status: "superseded", sentAt: at("2026-06-02T15:00:00Z") });
  await est(orgA, { status: "accepted", sentAt: at("2026-05-01T15:00:00Z") });
  await est(orgB, {
    status: "sent", sentAt: at("2026-06-05T15:00:00Z"),
    lineItems: { create: [{ name: "Other", quantity: 1, unitPriceCents: 999999 }] },
  });

  ids = { companyA: a.company, companyB: a.companyOther, agent: a.user, t1, t2, t3, contractA: contractA.id };
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } }).catch((e: unknown) => console.error(e));
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch((e: unknown) => console.error(e));
  await prisma?.$disconnect();
});

describe("ticket volume report", () => {
  it("counts created, resolved and backlog in the workspace's timezone", async () => {
    const r = await tickets.volume(await ctx(orgA));
    expect(r.range).toMatchObject({ from: "2026-06-01", to: "2026-06-30", timezone: TZ, bucket: "day" });
    expect(r.series).toHaveLength(30);
    expect(r.totals).toEqual({ created: 4, resolved: 3, backlog: 2 });
    const day = (k: string) => r.series.find((x) => x.bucket === k);
    expect(day("2026-06-09")?.created).toBe(1);
    expect(day("2026-06-10")?.created).toBe(0);
    // The ticket from May is open at the end of the 1st and resolved on the 2nd.
    expect(day("2026-06-01")?.backlog).toBe(1);
    expect(day("2026-06-02")?.resolved).toBe(1);
    expect(day("2026-06-02")?.backlog).toBe(0);
  });

  it("breaks down by priority, category, source and company", async () => {
    const r = await tickets.volume(await ctx(orgA));
    const by = (rows: { label: string; created: number; resolved: number }[], label: string) =>
      rows.find((x) => x.label === label);
    expect(by(r.byPriority, "High")).toMatchObject({ created: 1, resolved: 1 });
    expect(by(r.byPriority, "Normal")).toMatchObject({ created: 1, resolved: 2 });
    expect(by(r.byPriority, "Urgent")).toMatchObject({ created: 1, resolved: 0 });
    expect(r.byPriority[0].key).toBe("urgent");
    expect(by(r.byCategory, "Hardware")).toMatchObject({ created: 1, resolved: 1 });
    expect(by(r.byCategory, "Uncategorized")).toMatchObject({ created: 3, resolved: 2 });
    expect(by(r.bySource, "portal")).toMatchObject({ created: 3, resolved: 2 });
    expect(by(r.bySource, "email")).toMatchObject({ created: 1, resolved: 1 });
    expect(by(r.byCompany, "Sample Company A")).toMatchObject({ created: 3, resolved: 2 });
    expect(by(r.byCompany, "Sample Company B")).toMatchObject({ created: 1, resolved: 1 });
  });

  it("filters by company", async () => {
    const r = await tickets.volume(await ctx(orgA, { companyId: ids.companyB }));
    expect(r.totals).toEqual({ created: 1, resolved: 1, backlog: 0 });
  });

  it("buckets by week for longer ranges", async () => {
    const r = await tickets.volume(await contexts.resolve(orgA, { from: "2026-04-01", to: "2026-06-30" }, NOW));
    expect(r.range.bucket).toBe("week");
    expect(r.series[0].bucket).toBe("2026-03-30");
    expect(r.series.find((x) => x.bucket === "2026-06-08")?.created).toBe(1);
  });

  it("never counts another workspace", async () => {
    const r = await tickets.volume(await ctx(orgB));
    expect(r.totals).toEqual({ created: 1, resolved: 1, backlog: 0 });
    expect(r.byCompany.map((x) => x.label)).toEqual(["Sample Company A"]);
  });
});

describe("SLA report", () => {
  it("counts flags and open tickets past due as breached", async () => {
    const r = await tickets.sla(await ctx(orgA));
    expect(r.overall.tickets).toBe(4);
    expect(r.overall.firstResponse).toEqual({ met: 2, breached: 2, pending: 0, compliance: 50 });
    // The paused ticket is past its due time but not breached.
    expect(r.overall.resolution).toEqual({ met: 2, breached: 1, pending: 1, compliance: 66.7 });
    expect(r.breachedTotal).toBe(2);
    expect(r.breached.map((t) => t.id).sort()).toEqual([ids.t2, ids.t3].sort());
    const t3 = r.breached.find((t) => t.id === ids.t3);
    expect(t3).toMatchObject({ company: "Sample Company A", assignee: null, firstResponseBreached: true, resolutionBreached: true });
    expect(t3?.reference).toMatch(/^TKT-\d+$/);
    const t2 = r.breached.find((t) => t.id === ids.t2);
    expect(t2).toMatchObject({ assignee: "Agent One", firstResponseBreached: true, resolutionBreached: false });
  });

  it("groups by company and priority", async () => {
    const r = await tickets.sla(await ctx(orgA));
    const a = r.byCompany.find((x) => x.key === ids.companyA);
    expect(a?.firstResponse).toMatchObject({ met: 2, breached: 1, compliance: 66.7 });
    expect(a?.resolution).toMatchObject({ met: 1, breached: 1, pending: 1, compliance: 50 });
    expect(r.byPriority.find((x) => x.key === "urgent")?.resolution.breached).toBe(1);
  });

  it("is scoped to the workspace", async () => {
    const r = await tickets.sla(await ctx(orgB));
    expect(r.overall.tickets).toBe(1);
    expect(r.breachedTotal).toBe(1);
  });
});

describe("response times report", () => {
  it("computes median and p90 in wall-clock hours", async () => {
    const r = await tickets.responseTimes(await ctx(orgA));
    expect(r.overall.firstResponse).toEqual({ count: 3, medianHours: percentileCont([2, 6, 1], 0.5), p90Hours: 5.2 });
    expect(r.overall.resolution).toEqual({ count: 2, medianHours: 20, p90Hours: 28 });
    const agent = r.byAssignee.find((x) => x.key === ids.agent);
    expect(agent?.firstResponse).toEqual({ count: 2, medianHours: 4, p90Hours: 5.6 });
    expect(r.byAssignee.find((x) => x.key === null)?.label).toBe("Unassigned");
    expect(r.byPriority.find((x) => x.key === "high")?.resolution.medianHours).toBe(10);
  });
});

describe("CSAT report", () => {
  it("averages ratings over resolved and closed tickets", async () => {
    const r = await tickets.csat(await ctx(orgA));
    expect(r.overall).toMatchObject({ closed: 3, rated: 2, average: 4, responseRate: 66.7 });
    expect(r.distribution).toEqual([
      { rating: 1, count: 0 },
      { rating: 2, count: 0 },
      { rating: 3, count: 1 },
      { rating: 4, count: 0 },
      { rating: 5, count: 1 },
    ]);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toMatchObject({ rating: 5, comment: "Great help", company: "Sample Company A" });
    expect(r.byAssignee.find((x) => x.key === ids.agent)).toMatchObject({ closed: 2, rated: 2, average: 4 });
  });

  it("does not include another workspace's ratings", async () => {
    const r = await tickets.csat(await ctx(orgA));
    expect(r.comments.some((c) => c.comment === "Other org")).toBe(false);
    expect(r.distribution[0].count).toBe(0);
  });
});

describe("hours report", () => {
  it("splits time per company and compares contract time to the allowance", async () => {
    const c = await ctx(orgA);
    const r = await hoursSvc.hours(c);
    const a = r.companies.find((x) => x.companyId === ids.companyA);
    const allowanceSec =
      contractAllowanceMinutes(
        { startsAt: at("2026-01-01T00:00:00Z"), endsAt: null, coveredMinutes: 600, coveragePeriod: "monthly" },
        c.range.start,
        c.range.end,
      ) * 60;
    expect(allowanceSec).toBe(591 * 60);
    expect(a).toMatchObject({
      totalSec: 55800,
      billableSec: 10800,
      nonBillableSec: 45000,
      uninvoicedBillableSec: 7200,
      ticketSec: 5400,
      projectSec: 50400,
      contractSec: 39600,
      allowanceSec,
      overageSec: 39600 - allowanceSec,
    });
    expect(a?.contracts).toHaveLength(1);
    expect(a?.contracts[0]).toMatchObject({ id: ids.contractA, usedSec: 39600 });

    // A company with an allowance but no time still shows; cancelled contracts don't count.
    const b = r.companies.find((x) => x.companyId === ids.companyB);
    expect(b).toMatchObject({ totalSec: 0, allowanceSec: Math.round((900 * 30) / (365.25 / 4)) * 60, overageSec: 0 });
    expect(r.companies.find((x) => x.companyId === null)).toMatchObject({ totalSec: 3600, billableSec: 3600 });
    expect(r.totals.totalSec).toBe(55800 + 3600);
  });

  it("filters by company and stays in the workspace", async () => {
    const r = await hoursSvc.hours(await ctx(orgA, { companyId: ids.companyB }));
    expect(r.companies).toHaveLength(1);
    expect(r.totals.totalSec).toBe(0);
    const other = await hoursSvc.hours(await ctx(orgB));
    expect(other.totals.totalSec).toBe(7200);
  });
});

describe("revenue report", () => {
  it("uses the same invoice total in SQL as in code", async () => {
    const all = await prisma.invoice.findMany({ where: { organizationId: orgA }, include: { lineItems: true } });
    const rows = await prisma.$queryRawUnsafe<{ id: string; total: bigint }[]>(
      `SELECT i.id, ${invoiceTotalSql("i").sql} AS total FROM "invoice" i WHERE i."organizationId" = $1`,
      orgA,
    );
    const sqlTotals = new Map(rows.map((r) => [r.id, Number(r.total)]));
    for (const i of all) expect(sqlTotals.get(i.id)).toBe(invoiceTotalCents(i));
  });

  it("reports invoiced, collected, outstanding and aging", async () => {
    const r = await revenueSvc.revenue(await ctx(orgA));
    expect(r.totals).toEqual({
      invoicedCents: 26650 + 100000 + 1100,
      collectedCents: 26650,
      outstandingCents: 100000 + 50000 + 1100,
      overdueCents: 150000,
    });
    expect(r.monthly).toEqual([
      { month: "2026-06", invoicedCents: 127750, collectedCents: 26650, outstandingCents: 101100 },
    ]);
    expect(r.aging.totals).toEqual({ current: 1100, d1_30: 100000, d31_60: 0, d61_90: 50000, d90_plus: 0 });
    const a = r.aging.companies.find((x) => x.companyId === ids.companyA);
    expect(a).toMatchObject({ invoices: 2, totalCents: 101100 });
    const b = r.aging.companies.find((x) => x.companyId === ids.companyB);
    expect(b?.buckets.d61_90).toBe(50000);
  });

  it("normalises recurring schedules to MRR", async () => {
    const r = await revenueSvc.revenue(await ctx(orgA));
    expect(r.recurring.schedules).toBe(3);
    expect(r.recurring.mrrCents).toBe(50000 + 10000 + 2600);
    expect(r.recurring.companies.find((x) => x.companyId === ids.companyA)?.mrrCents).toBe(12600);
  });

  it("totals the estimate pipeline like the estimate editor", async () => {
    const r = await revenueSvc.revenue(await ctx(orgA));
    const expected = computeEstimateTotals(
      [
        { quantity: 1, unitPriceCents: 10000, taxRateBps: 1000, taxable: true, optional: false, selected: true, billingType: "fixed" },
        { quantity: 1, unitPriceCents: 5000, taxRateBps: 0, taxable: true, optional: true, selected: false, billingType: "fixed" },
        { quantity: 1, unitPriceCents: 2000, taxRateBps: 0, taxable: true, optional: false, selected: true, billingType: "recurring" },
      ],
      { type: "percent", value: 1000 },
      null,
    );
    expect(r.estimates).toEqual({
      openCount: 2,
      openCents: expected.totalCents,
      openRecurringCents: expected.recurringSubtotalCents,
      sentInRange: 4,
      accepted: 1,
      declined: 1,
      expired: 0,
      acceptanceRate: 25,
    });
    expect(expected.totalCents).toBe(9900);
  });

  it("never counts another workspace", async () => {
    const r = await revenueSvc.revenue(await ctx(orgB));
    expect(r.totals).toEqual({ invoicedCents: 888888, collectedCents: 888888, outstandingCents: 333333, overdueCents: 333333 });
    expect(r.recurring.mrrCents).toBe(77700);
    expect(r.estimates.openCount).toBe(1);
    const a = await revenueSvc.revenue(await ctx(orgA, { companyId: ids.companyB }));
    expect(a.totals.collectedCents).toBe(0);
    expect(a.aging.totals.d61_90).toBe(50000);
    expect(a.recurring.mrrCents).toBe(50000);
  });
});
