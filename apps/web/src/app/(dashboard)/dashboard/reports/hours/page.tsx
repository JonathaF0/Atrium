"use client";

import { formatHours } from "@/lib/format-duration";
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
  useReport,
} from "../_components/report-kit";
import type { RangeInfo } from "../_components/report-kit";

interface ContractUsage {
  id: string;
  name: string;
  coveragePeriod: string;
  allowanceSec: number;
  usedSec: number;
  overageSec: number;
}

interface HoursRow {
  companyId: string | null;
  companyName: string;
  totalSec: number;
  billableSec: number;
  nonBillableSec: number;
  uninvoicedBillableSec: number;
  ticketSec: number;
  projectSec: number;
  contractSec: number;
  allowanceSec: number;
  overageSec: number;
  contracts: ContractUsage[];
}

interface HoursReport {
  range: RangeInfo;
  totals: Omit<HoursRow, "companyId" | "companyName" | "contracts">;
  companies: HoursRow[];
}

export default function HoursReportPage(): React.ReactElement {
  const { report, loading, error, filters, setFilters, exportCsv } = useReport<HoursReport>("hours");
  const contracts = report?.companies.flatMap((c) => c.contracts.map((k) => ({ ...k, companyName: c.companyName }))) ?? [];

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Hours by client"
        description="Finished time entries started in the period, by the company they were for (the contract's company, else the ticket's, else the project's client). Contract allowances accrue evenly: covered hours per month, quarter or year, prorated to the days of the period the contract was active; a whole-term allowance is spread over the term."
        onExport={() => exportCsv()}
      />
      <ReportFilters filters={filters} range={report?.range ?? null} onChange={setFilters} />
      <ReportBody loading={loading} error={error} hasReport={report !== null}>
        {report && (
          <>
            <StatGrid>
              <StatCard label="Billable hours" value={formatHours(report.totals.billableSec)} />
              <StatCard label="Non-billable hours" value={formatHours(report.totals.nonBillableSec)} />
              <StatCard
                label="Contract hours used"
                value={formatHours(report.totals.contractSec)}
                hint={`of ${formatHours(report.totals.allowanceSec)} covered`}
              />
              <StatCard label="Un-invoiced billable" value={formatHours(report.totals.uninvoicedBillableSec)} />
            </StatGrid>
            {report.companies.length === 0 ? (
              <EmptyState message="No time logged and no contract allowances in this period." />
            ) : (
              <>
                <Section title="Billable vs non-billable by company">
                  <ColumnChart
                    ariaLabel="Billable and non-billable hours per company"
                    series={[
                      { key: "billable", label: "Billable" },
                      { key: "nonBillable", label: "Non-billable" },
                    ]}
                    points={report.companies.slice(0, 12).map((c) => ({
                      label: c.companyName.length > 14 ? `${c.companyName.slice(0, 13)}…` : c.companyName,
                      values: [c.billableSec / 3600, c.nonBillableSec / 3600],
                    }))}
                    format={(v) => `${v.toFixed(1)}h`}
                  />
                </Section>
                <Section title="By company">
                  <DataTable
                    rows={report.companies}
                    rowKey={(r) => r.companyId ?? "none"}
                    columns={[
                      { header: "Company", cell: (r) => r.companyName },
                      { header: "Total", cell: (r) => formatHours(r.totalSec), align: "right" },
                      { header: "Billable", cell: (r) => formatHours(r.billableSec), align: "right" },
                      { header: "Non-billable", cell: (r) => formatHours(r.nonBillableSec), align: "right" },
                      { header: "Un-invoiced", cell: (r) => formatHours(r.uninvoicedBillableSec), align: "right" },
                      { header: "Tickets", cell: (r) => formatHours(r.ticketSec), align: "right" },
                      { header: "Projects", cell: (r) => formatHours(r.projectSec), align: "right" },
                      { header: "Contract used", cell: (r) => formatHours(r.contractSec), align: "right" },
                      { header: "Covered", cell: (r) => formatHours(r.allowanceSec), align: "right" },
                      {
                        header: "Overage",
                        cell: (r) => (
                          <span className={r.overageSec > 0 ? "text-red-600 font-medium" : ""}>{formatHours(r.overageSec)}</span>
                        ),
                        align: "right",
                      },
                    ]}
                  />
                </Section>
                <Section title="Contracts">
                  <DataTable
                    rows={contracts}
                    rowKey={(r) => r.id}
                    empty="No contracts with covered hours in this period."
                    columns={[
                      { header: "Contract", cell: (r) => r.name },
                      { header: "Company", cell: (r) => r.companyName },
                      { header: "Period", cell: (r) => r.coveragePeriod },
                      { header: "Covered", cell: (r) => formatHours(r.allowanceSec), align: "right" },
                      { header: "Used", cell: (r) => formatHours(r.usedSec), align: "right" },
                      { header: "Overage", cell: (r) => formatHours(r.overageSec), align: "right" },
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
