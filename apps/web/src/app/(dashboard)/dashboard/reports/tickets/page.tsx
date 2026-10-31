"use client";

import { BarList, ColumnChart, LineChart, bucketLabel } from "../_components/charts";
import {
  DataTable,
  EmptyState,
  ReportBody,
  ReportFilters,
  ReportHeader,
  Section,
  StatCard,
  StatGrid,
  useReport,
} from "../_components/report-kit";
import type { RangeInfo } from "../_components/report-kit";

interface VolumeRow {
  key: string | null;
  label: string;
  created: number;
  resolved: number;
}

interface TicketVolumeReport {
  range: RangeInfo;
  totals: { created: number; resolved: number; backlog: number };
  series: { bucket: string; created: number; resolved: number; backlog: number }[];
  byCategory: VolumeRow[];
  byPriority: VolumeRow[];
  bySource: VolumeRow[];
  byCompany: VolumeRow[];
}

const SOURCE_LABELS: Record<string, string> = { portal: "Portal", email: "Email", staff: "Staff", api: "API" };

function Breakdown({ title, rows }: { title: string; rows: VolumeRow[] }): React.ReactElement {
  return (
    <Section title={title}>
      <DataTable
        rows={rows}
        rowKey={(r) => `${r.key ?? "none"}-${r.label}`}
        columns={[
          { header: title.replace(/^By /, ""), cell: (r) => r.label },
          { header: "Created", cell: (r) => r.created, align: "right" },
          { header: "Resolved", cell: (r) => r.resolved, align: "right" },
        ]}
      />
    </Section>
  );
}

export default function TicketVolumeReportPage(): React.ReactElement {
  const { report, loading, error, filters, setFilters, exportCsv } = useReport<TicketVolumeReport>("tickets");
  const empty = report !== null && report.totals.created === 0 && report.totals.resolved === 0 && report.totals.backlog === 0;

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Ticket volume"
        description="Tickets created and resolved (or closed) in the period, and how many were open at the end of each period. Merged duplicates are not counted."
        onExport={() => exportCsv()}
      />
      <ReportFilters filters={filters} range={report?.range ?? null} onChange={setFilters} />
      <ReportBody loading={loading} error={error} hasReport={report !== null}>
        {report && (
          <>
            <StatGrid>
              <StatCard label="Created" value={report.totals.created} />
              <StatCard label="Resolved" value={report.totals.resolved} />
              <StatCard label="Open at end" value={report.totals.backlog} />
              <StatCard
                label="Net change"
                value={report.totals.created - report.totals.resolved}
                hint="Created minus resolved"
              />
            </StatGrid>
            {empty ? (
              <EmptyState message="No tickets in this period." />
            ) : (
              <>
                <Section title="Created vs resolved">
                  <ColumnChart
                    ariaLabel="Tickets created and resolved per period"
                    series={[
                      { key: "created", label: "Created" },
                      { key: "resolved", label: "Resolved" },
                    ]}
                    points={report.series.map((s) => ({
                      label: bucketLabel(s.bucket, report.range.bucket),
                      values: [s.created, s.resolved],
                    }))}
                  />
                </Section>
                <Section title="Backlog (open at end of period)">
                  <LineChart
                    label="Open tickets at the end of each period"
                    points={report.series.map((s) => ({ label: bucketLabel(s.bucket, report.range.bucket), value: s.backlog }))}
                  />
                </Section>
                <div className="grid gap-6 md:grid-cols-2">
                  <Section title="Created by category">
                    <BarList rows={report.byCategory.map((r) => ({ label: r.label, value: r.created }))} />
                  </Section>
                  <Section title="Created by company">
                    <BarList rows={report.byCompany.slice(0, 10).map((r) => ({ label: r.label, value: r.created }))} />
                  </Section>
                </div>
                <div className="grid gap-6 md:grid-cols-2">
                  <Breakdown title="By priority" rows={report.byPriority} />
                  <Breakdown
                    title="By source"
                    rows={report.bySource.map((r) => ({ ...r, label: SOURCE_LABELS[r.label] ?? r.label }))}
                  />
                  <Breakdown title="By category" rows={report.byCategory} />
                  <Breakdown title="By company" rows={report.byCompany} />
                </div>
              </>
            )}
          </>
        )}
      </ReportBody>
    </div>
  );
}
