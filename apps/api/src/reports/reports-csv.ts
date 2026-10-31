import { toCsv } from "../common";
import type { CsvColumn } from "../common";
import { AGING_BUCKETS } from "./report-math";
import type { BreachedTicket, CsatReport, ResponseTimesReport, SlaReport, SlaRow, TicketVolumeReport } from "./ticket-reports.service";
import type { HoursReport } from "./hours-report.service";
import type { RevenueReport } from "./revenue-report.service";

const hrs = (sec: number): string => (sec / 3600).toFixed(2);
const money = (cents: number): string => (cents / 100).toFixed(2);
const pct = (v: number | null): string => (v === null ? "" : v.toFixed(1));
const opt = (v: number | null): string => (v === null ? "" : String(v));

export function ticketVolumeCsv(r: TicketVolumeReport): string {
  type Row = { section: string; group: string; created: number; resolved: number; backlog: number | null };
  const rows: Row[] = [
    ...r.series.map((s) => ({ section: "Period", group: s.bucket, created: s.created, resolved: s.resolved, backlog: s.backlog })),
    ...r.byCategory.map((s) => ({ section: "Category", group: s.label, created: s.created, resolved: s.resolved, backlog: null })),
    ...r.byPriority.map((s) => ({ section: "Priority", group: s.label, created: s.created, resolved: s.resolved, backlog: null })),
    ...r.bySource.map((s) => ({ section: "Source", group: s.label, created: s.created, resolved: s.resolved, backlog: null })),
    ...r.byCompany.map((s) => ({ section: "Company", group: s.label, created: s.created, resolved: s.resolved, backlog: null })),
  ];
  const cols: CsvColumn<Row>[] = [
    { header: "Section", value: (x) => x.section },
    { header: "Group", value: (x) => x.group },
    { header: "Created", value: (x) => x.created },
    { header: "Resolved", value: (x) => x.resolved },
    { header: "Open at end", value: (x) => x.backlog },
  ];
  return toCsv(cols, rows);
}

export function slaSummaryCsv(r: SlaReport): string {
  type Row = SlaRow & { section: string };
  const rows: Row[] = [
    { ...r.overall, section: "Overall" },
    ...r.byPriority.map((x) => ({ ...x, section: "Priority" })),
    ...r.byCategory.map((x) => ({ ...x, section: "Category" })),
    ...r.byCompany.map((x) => ({ ...x, section: "Company" })),
  ];
  const cols: CsvColumn<Row>[] = [
    { header: "Section", value: (x) => x.section },
    { header: "Group", value: (x) => x.label },
    { header: "Tickets", value: (x) => x.tickets },
    { header: "First response met", value: (x) => x.firstResponse.met },
    { header: "First response breached", value: (x) => x.firstResponse.breached },
    { header: "First response compliance %", value: (x) => pct(x.firstResponse.compliance) },
    { header: "Resolution met", value: (x) => x.resolution.met },
    { header: "Resolution breached", value: (x) => x.resolution.breached },
    { header: "Resolution compliance %", value: (x) => pct(x.resolution.compliance) },
  ];
  return toCsv(cols, rows);
}

export function slaBreachedCsv(rows: BreachedTicket[]): string {
  const cols: CsvColumn<BreachedTicket>[] = [
    { header: "Ticket", value: (x) => x.reference },
    { header: "Subject", value: (x) => x.subject },
    { header: "Priority", value: (x) => x.priority },
    { header: "Company", value: (x) => x.company },
    { header: "Assignee", value: (x) => x.assignee },
    { header: "First response breached", value: (x) => (x.firstResponseBreached ? "yes" : "no") },
    { header: "Resolution breached", value: (x) => (x.resolutionBreached ? "yes" : "no") },
    { header: "Created", value: (x) => x.createdAt },
  ];
  return toCsv(cols, rows);
}

export function responseTimesCsv(r: ResponseTimesReport): string {
  type Row = ResponseTimesReport["overall"] & { section: string };
  const rows: Row[] = [
    { ...r.overall, section: "Overall" },
    ...r.byPriority.map((x) => ({ ...x, section: "Priority" })),
    ...r.byAssignee.map((x) => ({ ...x, section: "Assignee" })),
  ];
  const cols: CsvColumn<Row>[] = [
    { header: "Section", value: (x) => x.section },
    { header: "Group", value: (x) => x.label },
    { header: "Tickets", value: (x) => x.tickets },
    { header: "Responded", value: (x) => x.firstResponse.count },
    { header: "First response median (h)", value: (x) => opt(x.firstResponse.medianHours) },
    { header: "First response p90 (h)", value: (x) => opt(x.firstResponse.p90Hours) },
    { header: "Resolved", value: (x) => x.resolution.count },
    { header: "Resolution median (h)", value: (x) => opt(x.resolution.medianHours) },
    { header: "Resolution p90 (h)", value: (x) => opt(x.resolution.p90Hours) },
  ];
  return toCsv(cols, rows);
}

export function csatCsv(r: CsatReport): string {
  type Row = CsatReport["overall"] & { section: string };
  const rows: Row[] = [
    { ...r.overall, section: "Overall" },
    ...r.byAssignee.map((x) => ({ ...x, section: "Assignee" })),
    ...r.byCompany.map((x) => ({ ...x, section: "Company" })),
  ];
  const cols: CsvColumn<Row>[] = [
    { header: "Section", value: (x) => x.section },
    { header: "Group", value: (x) => x.label },
    { header: "Resolved or closed", value: (x) => x.closed },
    { header: "Rated", value: (x) => x.rated },
    { header: "Response rate %", value: (x) => pct(x.responseRate) },
    { header: "Average rating", value: (x) => opt(x.average) },
  ];
  return toCsv(cols, rows);
}

export function hoursCsv(r: HoursReport): string {
  type Row = HoursReport["companies"][number];
  const cols: CsvColumn<Row>[] = [
    { header: "Company", value: (x) => x.companyName },
    { header: "Total hours", value: (x) => hrs(x.totalSec) },
    { header: "Billable hours", value: (x) => hrs(x.billableSec) },
    { header: "Non-billable hours", value: (x) => hrs(x.nonBillableSec) },
    { header: "Un-invoiced billable hours", value: (x) => hrs(x.uninvoicedBillableSec) },
    { header: "Ticket hours", value: (x) => hrs(x.ticketSec) },
    { header: "Project hours", value: (x) => hrs(x.projectSec) },
    { header: "Contract hours used", value: (x) => hrs(x.contractSec) },
    { header: "Contract allowance hours", value: (x) => hrs(x.allowanceSec) },
    { header: "Overage hours", value: (x) => hrs(x.overageSec) },
  ];
  return toCsv(cols, r.companies);
}

export function revenueCsv(r: RevenueReport): string {
  type Row = { section: string; group: string; a: string; b: string; c: string };
  const rows: Row[] = [
    ...r.monthly.map((m) => ({
      section: "Month",
      group: m.month,
      a: money(m.invoicedCents),
      b: money(m.collectedCents),
      c: money(m.outstandingCents),
    })),
  ];
  const monthCols: CsvColumn<Row>[] = [
    { header: "Section", value: (x) => x.section },
    { header: "Month", value: (x) => x.group },
    { header: "Invoiced", value: (x) => x.a },
    { header: "Collected", value: (x) => x.b },
    { header: "Outstanding", value: (x) => x.c },
  ];
  type AgingRow = RevenueReport["aging"]["companies"][number];
  const agingCols: CsvColumn<AgingRow>[] = [
    { header: "Section", value: () => "Aging" },
    { header: "Company", value: (x) => x.companyName },
    { header: "Open invoices", value: (x) => x.invoices },
    { header: "Total", value: (x) => money(x.totalCents) },
    ...AGING_BUCKETS.map((b) => ({ header: b.label, value: (x: AgingRow) => money(x.buckets[b.key]) })),
  ];
  // Two tables (monthly totals, then aging by company) separated by a blank line.
  return `${toCsv(monthCols, rows)}\r\n${toCsv(agingCols, r.aging.companies)}`;
}
