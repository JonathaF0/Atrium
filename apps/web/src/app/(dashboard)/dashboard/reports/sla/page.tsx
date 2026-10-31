"use client";

import { Download } from "lucide-react";
import { BarList } from "../_components/charts";
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

interface Outcome {
  met: number;
  breached: number;
  pending: number;
  compliance: number | null;
}

interface SlaRow {
  key: string | null;
  label: string;
  tickets: number;
  firstResponse: Outcome;
  resolution: Outcome;
}

interface BreachedTicket {
  id: string;
  reference: string;
  subject: string;
  priority: string;
  company: string | null;
  assignee: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  createdAt: string;
}

interface SlaReport {
  range: RangeInfo;
  overall: SlaRow;
  byPriority: SlaRow[];
  byCategory: SlaRow[];
  byCompany: SlaRow[];
  breached: BreachedTicket[];
  breachedTotal: number;
}

function Groups({ title, rows }: { title: string; rows: SlaRow[] }): React.ReactElement {
  return (
    <Section title={title}>
      <DataTable
        rows={rows}
        rowKey={(r) => `${r.key ?? "none"}-${r.label}`}
        columns={[
          { header: title.replace(/^By /, ""), cell: (r) => r.label },
          { header: "Tickets", cell: (r) => r.tickets, align: "right" },
          { header: "First response", cell: (r) => fmtPercent(r.firstResponse.compliance), align: "right" },
          { header: "Responses missed", cell: (r) => r.firstResponse.breached, align: "right" },
          { header: "Resolution", cell: (r) => fmtPercent(r.resolution.compliance), align: "right" },
          { header: "Resolutions missed", cell: (r) => r.resolution.breached, align: "right" },
        ]}
      />
    </Section>
  );
}

export default function SlaReportPage(): React.ReactElement {
  const { report, loading, error, filters, setFilters, exportCsv } = useReport<SlaReport>("sla");

  return (
    <div className="space-y-6">
      <ReportHeader
        title="SLA compliance"
        description="Tickets created in the period against their first response and resolution targets. Targets run on business hours and pause while a ticket waits on the client. A target counts as breached when it was missed, or when an open, unpaused ticket is past its due time; tickets still inside their target are pending and left out of the percentage."
        onExport={() => exportCsv()}
      >
        <button
          onClick={() => exportCsv({ table: "breached" })}
          className="flex items-center gap-1.5 px-3 py-2 border border-[var(--border)] rounded-lg text-sm"
        >
          <Download size={16} /> Breached tickets
        </button>
      </ReportHeader>
      <ReportFilters filters={filters} range={report?.range ?? null} onChange={setFilters} />
      <ReportBody loading={loading} error={error} hasReport={report !== null}>
        {report && (
          <>
            <StatGrid>
              <StatCard
                label="First response met"
                value={fmtPercent(report.overall.firstResponse.compliance)}
                hint={`${report.overall.firstResponse.met} met, ${report.overall.firstResponse.breached} breached`}
              />
              <StatCard
                label="Resolution met"
                value={fmtPercent(report.overall.resolution.compliance)}
                hint={`${report.overall.resolution.met} met, ${report.overall.resolution.breached} breached`}
              />
              <StatCard label="Tickets" value={report.overall.tickets} />
              <StatCard label="Breached tickets" value={report.breachedTotal} />
            </StatGrid>
            {report.overall.tickets === 0 ? (
              <EmptyState message="No tickets were created in this period." />
            ) : (
              <>
                <Section title="Resolution compliance by priority">
                  <BarList
                    rows={report.byPriority.map((r) => ({ label: r.label, value: r.resolution.compliance ?? 0 }))}
                    format={(v) => `${v.toFixed(1)}%`}
                  />
                </Section>
                <div className="grid gap-6 lg:grid-cols-2">
                  <Groups title="By priority" rows={report.byPriority} />
                  <Groups title="By category" rows={report.byCategory} />
                </div>
                <Groups title="By company" rows={report.byCompany} />
                <Section title={`Breached tickets (${report.breachedTotal})`}>
                  <DataTable
                    rows={report.breached}
                    rowKey={(r) => r.id}
                    empty="No breached tickets in this period."
                    columns={[
                      { header: "Ticket", cell: (r) => r.reference },
                      { header: "Subject", cell: (r) => r.subject },
                      { header: "Company", cell: (r) => r.company ?? "–" },
                      { header: "Assignee", cell: (r) => r.assignee ?? "Unassigned" },
                      {
                        header: "Missed",
                        cell: (r) =>
                          [r.firstResponseBreached && "First response", r.resolutionBreached && "Resolution"]
                            .filter(Boolean)
                            .join(", "),
                      },
                    ]}
                  />
                  {report.breached.length < report.breachedTotal && (
                    <p className="text-xs text-[var(--muted-foreground)] mt-2">
                      Showing the latest {report.breached.length}. Export the full list as CSV.
                    </p>
                  )}
                </Section>
              </>
            )}
          </>
        )}
      </ReportBody>
    </div>
  );
}
