"use client";

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

interface CsatRow {
  key: string | null;
  label: string;
  closed: number;
  rated: number;
  average: number | null;
  responseRate: number | null;
}

interface CsatReport {
  range: RangeInfo;
  overall: CsatRow;
  distribution: { rating: number; count: number }[];
  byAssignee: CsatRow[];
  byCompany: CsatRow[];
  comments: { reference: string; rating: number; comment: string; company: string | null; ratedAt: string | null }[];
}

const fmtAvg = (v: number | null): string => (v === null ? "–" : `${v.toFixed(2)} / 5`);

function Groups({ title, rows }: { title: string; rows: CsatRow[] }): React.ReactElement {
  return (
    <Section title={title}>
      <DataTable
        rows={rows}
        rowKey={(r) => `${r.key ?? "none"}-${r.label}`}
        columns={[
          { header: title.replace(/^By /, ""), cell: (r) => r.label },
          { header: "Resolved", cell: (r) => r.closed, align: "right" },
          { header: "Rated", cell: (r) => r.rated, align: "right" },
          { header: "Response rate", cell: (r) => fmtPercent(r.responseRate), align: "right" },
          { header: "Average", cell: (r) => fmtAvg(r.average), align: "right" },
        ]}
      />
    </Section>
  );
}

export default function CsatReportPage(): React.ReactElement {
  const { report, loading, error, filters, setFilters, exportCsv } = useReport<CsatReport>("csat");

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Customer satisfaction"
        description="Ratings clients gave tickets resolved or closed in the period. Response rate is rated tickets out of resolved or closed tickets."
        onExport={() => exportCsv()}
      />
      <ReportFilters filters={filters} range={report?.range ?? null} onChange={setFilters} />
      <ReportBody loading={loading} error={error} hasReport={report !== null}>
        {report && (
          <>
            <StatGrid>
              <StatCard label="Average rating" value={fmtAvg(report.overall.average)} />
              <StatCard label="Response rate" value={fmtPercent(report.overall.responseRate)} />
              <StatCard label="Ratings" value={report.overall.rated} />
              <StatCard label="Resolved or closed" value={report.overall.closed} />
            </StatGrid>
            {report.overall.rated === 0 ? (
              <EmptyState message="No ratings in this period." />
            ) : (
              <>
                <Section title="Rating distribution">
                  <BarList
                    rows={[...report.distribution].reverse().map((d) => ({ label: `${d.rating} star${d.rating === 1 ? "" : "s"}`, value: d.count }))}
                  />
                </Section>
                <div className="grid gap-6 lg:grid-cols-2">
                  <Groups title="By assignee" rows={report.byAssignee} />
                  <Groups title="By company" rows={report.byCompany} />
                </div>
                <Section title="Recent comments">
                  <DataTable
                    rows={report.comments}
                    rowKey={(r) => r.reference}
                    empty="No comments in this period."
                    columns={[
                      { header: "Ticket", cell: (r) => r.reference },
                      { header: "Rating", cell: (r) => `${r.rating} / 5` },
                      { header: "Comment", cell: (r) => <span className="whitespace-pre-wrap">{r.comment}</span> },
                      { header: "Company", cell: (r) => r.company ?? "–" },
                    ]}
                  />
                </Section>
              </>
            )}
          </>
        )}
      </ReportBody>
    </div>
  );
}
