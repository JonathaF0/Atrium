"use client";

import { formatCurrency } from "@/lib/format";
import { useCurrency } from "@/lib/app-config";
import { ColumnChart, bucketLabel } from "../_components/charts";
import {
  DataTable,
  EmptyState,
  ReportBody,
  ReportFilters,
  ReportHeader,
  Section,
  StatCard,
  StatGrid,
  fmtPercent,
  useReport,
} from "../_components/report-kit";
import type { RangeInfo } from "../_components/report-kit";

type AgingKey = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

const AGING: { key: AgingKey; label: string }[] = [
  { key: "current", label: "Current" },
  { key: "d1_30", label: "1-30 days" },
  { key: "d31_60", label: "31-60 days" },
  { key: "d61_90", label: "61-90 days" },
  { key: "d90_plus", label: "90+ days" },
];

interface AgingRow {
  companyId: string | null;
  companyName: string;
  invoices: number;
  totalCents: number;
  buckets: Record<AgingKey, number>;
}

interface RevenueReport {
  range: RangeInfo;
  totals: { invoicedCents: number; collectedCents: number; outstandingCents: number; overdueCents: number };
  monthly: { month: string; invoicedCents: number; collectedCents: number; outstandingCents: number }[];
  aging: { totals: Record<AgingKey, number>; companies: AgingRow[] };
  recurring: {
    mrrCents: number;
    arrCents: number;
    schedules: number;
    companies: { companyId: string | null; companyName: string; mrrCents: number }[];
  };
  estimates: {
    openCount: number;
    openCents: number;
    openRecurringCents: number;
    sentInRange: number;
    accepted: number;
    declined: number;
    expired: number;
    acceptanceRate: number | null;
  };
}

export default function RevenueReportPage(): React.ReactElement {
  const currency = useCurrency();
  const money = (cents: number): string => formatCurrency(cents, currency);
  const { report, loading, error, filters, setFilters, exportCsv } = useReport<RevenueReport>("revenue");
  const noInvoices =
    report !== null &&
    report.monthly.every((m) => m.invoicedCents === 0 && m.collectedCents === 0) &&
    report.aging.companies.length === 0;

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Revenue and aging"
        description="Invoiced is the total (with line-item tax) of invoices issued in the period; collected is payments received in it. Outstanding and aging cover every unpaid invoice today, by days past due. MRR normalises active recurring schedules to a month, before tax."
        onExport={() => exportCsv()}
      />
      <ReportFilters filters={filters} range={report?.range ?? null} onChange={setFilters} />
      <ReportBody loading={loading} error={error} hasReport={report !== null}>
        {report && (
          <>
            <StatGrid>
              <StatCard label="Invoiced" value={money(report.totals.invoicedCents)} />
              <StatCard label="Collected" value={money(report.totals.collectedCents)} />
              <StatCard
                label="Outstanding"
                value={money(report.totals.outstandingCents)}
                hint={`${money(report.totals.overdueCents)} overdue`}
              />
              <StatCard
                label="Monthly recurring"
                value={money(report.recurring.mrrCents)}
                hint={`${report.recurring.schedules} active schedule${report.recurring.schedules === 1 ? "" : "s"}`}
              />
            </StatGrid>

            {noInvoices ? (
              <EmptyState message="No invoices in this period and nothing outstanding." />
            ) : (
              <>
                <Section title="By month">
                  <ColumnChart
                    ariaLabel="Invoiced, collected and outstanding per month"
                    series={[
                      { key: "invoiced", label: "Invoiced" },
                      { key: "collected", label: "Collected" },
                      { key: "outstanding", label: "Still outstanding" },
                    ]}
                    points={report.monthly.map((m) => ({
                      label: bucketLabel(`${m.month}-01`, "month"),
                      values: [m.invoicedCents / 100, m.collectedCents / 100, m.outstandingCents / 100],
                    }))}
                    format={(v) => formatCurrency(Math.round(v * 100), currency)}
                  />
                  <div className="mt-3">
                    <DataTable
                      rows={report.monthly}
                      rowKey={(r) => r.month}
                      columns={[
                        { header: "Month", cell: (r) => r.month },
                        { header: "Invoiced", cell: (r) => money(r.invoicedCents), align: "right" },
                        { header: "Collected", cell: (r) => money(r.collectedCents), align: "right" },
                        { header: "Still outstanding", cell: (r) => money(r.outstandingCents), align: "right" },
                      ]}
                    />
                  </div>
                </Section>
                <Section title="Receivables aging">
                  <DataTable
                    rows={report.aging.companies}
                    rowKey={(r) => r.companyId ?? "none"}
                    empty="No unpaid invoices."
                    columns={[
                      { header: "Company", cell: (r) => r.companyName },
                      { header: "Invoices", cell: (r) => r.invoices, align: "right" },
                      ...AGING.map((b) => ({
                        header: b.label,
                        cell: (r: AgingRow) => (r.buckets[b.key] ? money(r.buckets[b.key]) : "–"),
                        align: "right" as const,
                      })),
                      { header: "Total", cell: (r) => money(r.totalCents), align: "right" },
                    ]}
                  />
                  {report.aging.companies.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-4 text-xs text-[var(--muted-foreground)]">
                      {AGING.map((b) => (
                        <span key={b.key}>
                          {b.label}: <span className="text-[var(--foreground)]">{money(report.aging.totals[b.key])}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </Section>
              </>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
              <Section title="Recurring revenue">
                <DataTable
                  rows={report.recurring.companies}
                  rowKey={(r) => r.companyId ?? "none"}
                  empty="No active recurring invoices."
                  columns={[
                    { header: "Company", cell: (r) => r.companyName },
                    { header: "MRR", cell: (r) => money(r.mrrCents), align: "right" },
                    { header: "ARR", cell: (r) => money(r.mrrCents * 12), align: "right" },
                  ]}
                />
              </Section>
              <Section title="Estimate pipeline">
                <div className="grid grid-cols-2 gap-4">
                  <StatCard
                    label="Open estimates"
                    value={money(report.estimates.openCents)}
                    hint={`${report.estimates.openCount} sent or viewed${
                      report.estimates.openRecurringCents
                        ? `, plus ${money(report.estimates.openRecurringCents)} recurring`
                        : ""
                    }`}
                  />
                  <StatCard
                    label="Acceptance rate"
                    value={fmtPercent(report.estimates.acceptanceRate)}
                    hint={`${report.estimates.accepted} of ${report.estimates.sentInRange} sent in the period accepted, ${report.estimates.declined} declined`}
                  />
                </div>
              </Section>
            </div>
          </>
        )}
      </ReportBody>
    </div>
  );
}
