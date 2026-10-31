"use client";

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { apiFetch, fetchAllPages } from "@/lib/api";
import { downloadCsv } from "@/lib/download";

export interface RangeInfo {
  from: string;
  to: string;
  timezone: string;
  bucket: "day" | "week" | "month";
  companyId: string | null;
}

export interface ReportFilterState {
  from: string;
  to: string;
  companyId: string;
}

interface Company {
  id: string;
  name: string;
}

function toQuery(f: ReportFilterState, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.companyId) params.set("companyId", f.companyId);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Loads `/reports/<name>` whenever the filters change. */
export function useReport<T extends { range: RangeInfo }>(
  name: string,
): {
  report: T | null;
  loading: boolean;
  error: string | null;
  filters: ReportFilterState;
  setFilters: (f: ReportFilterState) => void;
  exportCsv: (extra?: Record<string, string>) => void;
} {
  const [filters, setFilters] = useState<ReportFilterState>({ from: "", to: "", companyId: "" });
  const [report, setReport] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setReport(await apiFetch<T>(`/reports/${name}${toQuery(filters)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the report");
    } finally {
      setLoading(false);
    }
  }, [name, filters]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = (extra: Record<string, string> = {}): void => {
    downloadCsv(`/reports/${name}/export${toQuery(filters, extra)}`).catch((err) => console.error(err));
  };

  return { report, loading, error, filters, setFilters, exportCsv };
}

const inputClass = "rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm";

export function ReportHeader({
  title,
  description,
  onExport,
  children,
}: {
  title: string;
  description?: string;
  onExport: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {description && <p className="text-sm text-[var(--muted-foreground)] mt-1 max-w-2xl">{description}</p>}
      </div>
      <div className="flex gap-2">
        {children}
        <button
          onClick={onExport}
          className="flex items-center gap-1.5 px-3 py-2 border border-[var(--border)] rounded-lg text-sm"
        >
          <Download size={16} /> Export CSV
        </button>
      </div>
    </div>
  );
}

/** Date range and company filters. Empty dates mean the server's default (last 30 days). */
export function ReportFilters({
  filters,
  range,
  onChange,
}: {
  filters: ReportFilterState;
  range: RangeInfo | null;
  onChange: (f: ReportFilterState) => void;
}): React.ReactElement {
  const [companies, setCompanies] = useState<Company[]>([]);

  useEffect(() => {
    fetchAllPages<Company>("/companies")
      .then(setCompanies)
      .catch((err) => console.error(err));
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        aria-label="Company"
        value={filters.companyId}
        onChange={(e) => onChange({ ...filters, companyId: e.target.value })}
        className={inputClass}
      >
        <option value="">All companies</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <input
        type="date"
        aria-label="From"
        value={filters.from || range?.from || ""}
        onChange={(e) => onChange({ ...filters, from: e.target.value })}
        className={inputClass}
      />
      <input
        type="date"
        aria-label="To"
        value={filters.to || range?.to || ""}
        onChange={(e) => onChange({ ...filters, to: e.target.value })}
        className={inputClass}
      />
      {range && (
        <span className="text-xs text-[var(--muted-foreground)]">
          Times in {range.timezone}
          {range.bucket !== "day" ? `, grouped by ${range.bucket}` : ""}
        </span>
      )}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}): React.ReactElement {
  return (
    <div className="border border-[var(--border)] rounded-lg p-4">
      <div className="text-xs text-[var(--muted-foreground)]">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {hint && <div className="text-xs text-[var(--muted-foreground)] mt-1">{hint}</div>}
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="grid grid-cols-2 md:grid-cols-4 gap-4">{children}</div>;
}

export function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <h2 className="text-sm font-medium mb-2">{title}</h2>
      {children}
    </div>
  );
}

export interface Column<T> {
  header: string;
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right";
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty = "No data for this period.",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  empty?: string;
}): React.ReactElement {
  if (rows.length === 0) return <EmptyState message={empty} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border border-[var(--border)] rounded-lg text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--muted-foreground)]">
            {columns.map((c) => (
              <th key={c.header} className={`p-2 ${c.align === "right" ? "text-right" : ""}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} className="border-t border-[var(--border)]">
              {columns.map((c) => (
                <td key={c.header} className={`p-2 ${c.align === "right" ? "text-right tabular-nums" : ""}`}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ message }: { message: string }): React.ReactElement {
  return (
    <div className="border border-dashed border-[var(--border)] rounded-lg p-6 text-center text-sm text-[var(--muted-foreground)]">
      {message}
    </div>
  );
}

export function ReportBody({
  loading,
  error,
  hasReport,
  children,
}: {
  loading: boolean;
  error: string | null;
  hasReport: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  if (error) return <div className="text-sm text-red-600">{error}</div>;
  if (loading && !hasReport) return <div className="text-sm text-[var(--muted-foreground)]">Loading…</div>;
  return <div className={`space-y-6 ${loading ? "opacity-60" : ""}`}>{children}</div>;
}

export function fmtPercent(v: number | null): string {
  return v === null ? "–" : `${v.toFixed(1)}%`;
}

export function fmtHoursValue(v: number | null): string {
  return v === null ? "–" : `${v.toFixed(1)} h`;
}
