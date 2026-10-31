"use client";

import { ColumnChart } from "../_components/charts";
import {
  DataTable,
  EmptyState,
  ReportBody,
  ReportFilters,
  ReportHeader,
  Section,
  StatCard,
  StatGrid,
  fmtHoursValue,
  useReport,
} from "../_components/report-kit";
import type { RangeInfo } from "../_components/report-kit";

interface Timing {
  count: number;
  medianHours: number | null;
  p90Hours: number | null;
}

interface TimeRow {
  key: string | null;
  label: string;
  tickets: number;
  firstResponse: Timing;
  resolution: Timing;
}

interface ResponseTimesReport {
  range: RangeInfo;
  overall: TimeRow;
  byPriority: TimeRow[];
  byAssignee: TimeRow[];
}

function Groups({ title, rows }: { title: string; rows: TimeRow[] }): React.ReactElement {
  return (
    <Section title={title}>
      <DataTable
        rows={rows}
        rowKey={(r) => `${r.key ?? "none"}-${r.label}`}
        columns={[
          { header: title.replace(/^By /, ""), cell: (r) => r.label },
          { header: "Tickets", cell: (r) => r.tickets, align: "right" },
          { header: "First response median", cell: (r) => fmtHoursValue(r.firstResponse.medianHours), align: "right" },
          { header: "First response p90", cell: (r) => fmtHoursValue(r.firstResponse.p90Hours), align: "right" },
          { header: "Resolution median", cell: (r) => fmtHoursValue(r.resolution.medianHours), align: "right" },
          { header: "Resolution p90", cell: (r) => fmtHoursValue(r.resolution.p90Hours), align: "right" },
        ]}
      />
    </Section>
  );
}

export default function ResponseTimesReportPage(): React.ReactElement {
  const { report, loading, error, filters, setFilters, exportCsv } = useReport<ResponseTimesReport>("response-times");

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Response and resolution times"
        description="For tickets created in the period: time from creation to the first staff reply, and to resolution. These are wall-clock hours, including nights and weekends; business-hours SLA timers are in the SLA report."
        onExport={() => exportCsv()}
      />
      <ReportFilters filters={filters} range={report?.range ?? null} onChange={setFilters} />
      <ReportBody loading={loading} error={error} hasReport={report !== null}>
        {report && (
          <>
            <StatGrid>
              <StatCard label="First response, median" value={fmtHoursValue(report.overall.firstResponse.medianHours)} />
              <StatCard label="First response, 90th percentile" value={fmtHoursValue(report.overall.firstResponse.p90Hours)} />
              <StatCard label="Resolution, median" value={fmtHoursValue(report.overall.resolution.medianHours)} />
              <StatCard label="Resolution, 90th percentile" value={fmtHoursValue(report.overall.resolution.p90Hours)} />
            </StatGrid>
            {report.overall.tickets === 0 ? (
              <EmptyState message="No tickets were created in this period." />
            ) : (
              <>
                <Section title="Median hours by priority">
                  <ColumnChart
                    ariaLabel="Median first response and resolution hours by priority"
                    series={[
                      { key: "fr", label: "First response" },
                      { key: "res", label: "Resolution" },
                    ]}
                    points={report.byPriority.map((r) => ({
                      label: r.label,
                      values: [r.firstResponse.medianHours ?? 0, r.resolution.medianHours ?? 0],
                    }))}
                    format={(v) => `${v.toFixed(1)}h`}
                  />
                </Section>
                <Groups title="By priority" rows={report.byPriority} />
                <Groups title="By assignee" rows={report.byAssignee} />
              </>
            )}
          </>
        )}
      </ReportBody>
    </div>
  );
}
