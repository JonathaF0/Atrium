"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FileSignature, Plus, Search } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useDebounce } from "@/hooks/use-debounce";
import { useCurrency } from "@/lib/app-config";
import { formatCurrency } from "@/lib/format";
import { Pagination } from "@/components/pagination";
import { EstimateStatusBadge } from "@/components/estimate-status-badge";

interface EstimateRow {
  id: string;
  number: string;
  version: number;
  status: string;
  title: string;
  company: { id: string; name: string } | null;
  recipient: { id: string; name: string | null } | null;
  validUntil: string | null;
  sentAt: string | null;
  createdAt: string;
  totals: { totalCents: number; recurringSubtotalCents: number };
}

interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

const FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "open", label: "Open" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "accepted", label: "Accepted" },
  { value: "converted", label: "Converted" },
  { value: "declined", label: "Declined" },
  { value: "expired", label: "Expired" },
];

export default function EstimatesPage() {
  const currency = useCurrency();
  const [rows, setRows] = useState<EstimateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const debounced = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (filter === "open") params.set("group", "open");
      else if (filter) params.set("status", filter);
      if (debounced) params.set("search", debounced);
      const res = await apiFetch<Paginated<EstimateRow>>(`/estimates?${params}`);
      setRows(res.data);
      setTotalPages(res.meta.totalPages);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load estimates");
    } finally {
      setLoading(false);
    }
  }, [page, filter, debounced]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => setPage(1), [filter, debounced]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Estimates</h1>
        <Link
          href="/dashboard/estimates/new"
          className="flex items-center gap-2 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium hover:opacity-90"
        >
          <Plus size={16} /> New estimate
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-0 sm:max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, number or company..."
            maxLength={200}
            className="w-full pl-9 pr-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.value || "all"}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                filter === f.value
                  ? "bg-[var(--primary)] text-white border-[var(--primary)]"
                  : "border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}

      {loading ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-[var(--border)] rounded-xl">
          <FileSignature size={28} className="mx-auto mb-3 text-[var(--muted-foreground)]" />
          <p className="text-sm text-[var(--muted-foreground)]">
            {filter || debounced ? "No estimates match these filters." : "No estimates yet. Build one from your catalog."}
          </p>
        </div>
      ) : (
        <div className="border border-[var(--border)] rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="bg-[var(--muted)] text-left">
                <th className="px-3 py-2 font-medium">Number</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Valid until</th>
                <th className="px-3 py-2 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="estimate-row" className="border-t border-[var(--border)] hover:bg-[var(--muted)]/50">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Link href={`/dashboard/estimates/${r.id}`} className="font-medium hover:underline">
                      {r.number}
                    </Link>
                    {r.version > 1 && <span className="ml-1 text-xs text-[var(--muted-foreground)]">v{r.version}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/dashboard/estimates/${r.id}`} className="hover:underline">
                      {r.title}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-[var(--muted-foreground)]">
                    {[r.company?.name, r.recipient?.name].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <EstimateStatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-[var(--muted-foreground)] whitespace-nowrap">
                    {r.validUntil ? new Date(r.validUntil).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {formatCurrency(r.totals.totalCents, currency)}
                    {r.totals.recurringSubtotalCents > 0 && (
                      <div className="text-xs text-[var(--muted-foreground)]">
                        + {formatCurrency(r.totals.recurringSubtotalCents, currency)} recurring
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
