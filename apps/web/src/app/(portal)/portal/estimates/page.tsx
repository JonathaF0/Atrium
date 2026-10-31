"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileSignature } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useCurrency } from "@/lib/app-config";
import { formatCurrency } from "@/lib/format";
import { Pagination } from "@/components/pagination";
import { EstimateStatusBadge } from "@/components/estimate-status-badge";

interface MineRow {
  id: string;
  number: string;
  version: number;
  status: string;
  title: string;
  validUntil: string | null;
  sentAt: string | null;
  totals: { totalCents: number; recurringSubtotalCents: number };
}

interface Paginated<T> {
  data: T[];
  meta: { totalPages: number };
}

const OPEN = new Set(["sent", "viewed", "changes_requested"]);

export default function PortalEstimatesPage() {
  const currency = useCurrency();
  const [rows, setRows] = useState<MineRow[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<Paginated<MineRow>>(`/estimates/mine?page=${page}&limit=20`)
      .then((r) => {
        setRows(r.data);
        setTotalPages(r.meta.totalPages);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load estimates"));
  }, [page]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Estimates</h1>
      {error && <div className="p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}
      {rows === null && !error ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
      ) : rows && rows.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-[var(--border)] rounded-xl">
          <FileSignature size={28} className="mx-auto mb-3 text-[var(--muted-foreground)]" />
          <p className="text-sm text-[var(--muted-foreground)]">No estimates yet.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows?.map((r) => (
            <li key={r.id}>
              <Link
                href={`/portal/estimates/${r.id}`}
                data-testid="portal-estimate-row"
                className="flex flex-wrap items-center justify-between gap-3 border border-[var(--border)] rounded-xl p-4 hover:bg-[var(--muted)]/50"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{r.title}</p>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    {r.number}
                    {r.version > 1 && ` v${r.version}`}
                    {r.validUntil && OPEN.has(r.status) && ` · valid until ${new Date(r.validUntil).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">{formatCurrency(r.totals.totalCents, currency)}</span>
                  <EstimateStatusBadge status={r.status} />
                  {OPEN.has(r.status) && <span className="text-xs text-[var(--primary)]">Review</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
