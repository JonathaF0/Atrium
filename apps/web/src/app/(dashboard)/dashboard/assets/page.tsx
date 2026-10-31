"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Download, Plus, Upload } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { downloadCsv } from "@/lib/download";
import { useCachedApi } from "@/lib/cached";
import { useToast } from "@/components/toast";
import { Pagination } from "@/components/pagination";
import { ClientItemSkeleton } from "@/components/skeletons";
import { inputClass } from "../contacts/shared";
import { AssetFormModal } from "./asset-form-modal";
import { ImportAssetsModal } from "./import-assets-modal";
import {
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  ASSET_TYPES,
  ASSET_TYPE_LABELS,
  EXPIRING_CHIPS,
  dueClass,
  formatDay,
  nextDate,
} from "./shared";
import type { Asset, Paginated } from "./shared";

const buttonClass =
  "inline-flex items-center gap-1.5 px-3 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)] transition-colors";

function positiveInt(value: string | null): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default function AssetsPage() {
  const searchParams = useSearchParams();
  const { error: showError } = useToast();
  const companies = useCachedApi<{ data: { id: string; name: string }[] }>("/companies?limit=100")?.data ?? [];
  const [companyId, setCompanyId] = useState(searchParams.get("companyId") ?? "");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [expiring, setExpiring] = useState<number | null>(positiveInt(searchParams.get("expiring")));
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Paginated<Asset> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Asset | "new" | null>(null);
  const [importing, setImporting] = useState(false);

  const query = useCallback((): string => {
    const params = new URLSearchParams();
    if (companyId) params.set("companyId", companyId);
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    if (expiring) params.set("expiringWithinDays", String(expiring));
    return params.toString();
  }, [companyId, type, status, q, expiring]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const qs = query();
      setResult(await apiFetch<Paginated<Asset>>(`/assets?page=${page}&limit=25${qs ? `&${qs}` : ""}`));
    } catch (err) {
      console.error(err);
      showError("Failed to load assets");
    } finally {
      setLoading(false);
    }
  }, [page, query, showError]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  // Deep link from a renewal notice: /dashboard/assets?asset=<id>
  const deepLinked = searchParams.get("asset");
  useEffect(() => {
    if (!deepLinked) return;
    apiFetch<Asset>(`/assets/${deepLinked}`)
      .then(setEditing)
      .catch((err) => console.error(err));
  }, [deepLinked]);

  async function exportCsv(): Promise<void> {
    try {
      const qs = query();
      await downloadCsv(`/assets/export${qs ? `?${qs}` : ""}`);
    } catch (err) {
      console.error(err);
      showError("Export failed");
    }
  }

  function resetPage<T>(set: (v: T) => void): (v: T) => void {
    return (v: T) => {
      set(v);
      setPage(1);
    };
  }

  const assets = result?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Assets</h1>
          <p className="text-sm text-[var(--muted-foreground)]">Devices, licenses, domains and services you manage for clients.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setImporting(true)} className={buttonClass}>
            <Upload size={16} /> Import
          </button>
          <button onClick={exportCsv} className={buttonClass}>
            <Download size={16} /> Export CSV
          </button>
          <button
            onClick={() => setEditing("new")}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90"
          >
            <Plus size={16} /> Add asset
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search assets"
          placeholder="Search name, serial, vendor..."
          value={q}
          onChange={(e) => resetPage(setQ)(e.target.value)}
          maxLength={200}
          className={`${inputClass} max-w-xs`}
        />
        <select aria-label="Company" value={companyId} onChange={(e) => resetPage(setCompanyId)(e.target.value)} className={`${inputClass} w-auto`}>
          <option value="">All companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Type" value={type} onChange={(e) => resetPage(setType)(e.target.value)} className={`${inputClass} w-auto`}>
          <option value="">All types</option>
          {ASSET_TYPES.map((t) => (
            <option key={t} value={t}>
              {ASSET_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select aria-label="Status" value={status} onChange={(e) => resetPage(setStatus)(e.target.value)} className={`${inputClass} w-auto`}>
          <option value="">Any status</option>
          {ASSET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ASSET_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1" role="group" aria-label="Expiring soon">
          {EXPIRING_CHIPS.map((days) => (
            <button
              key={days}
              type="button"
              aria-pressed={expiring === days}
              onClick={() => resetPage(setExpiring)(expiring === days ? null : days)}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                expiring === days
                  ? "bg-[var(--primary)] text-white border-[var(--primary)]"
                  : "border-[var(--border)] hover:bg-[var(--muted)]"
              }`}
            >
              Expiring in {days} days
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          <ClientItemSkeleton />
          <ClientItemSkeleton />
        </div>
      ) : assets.length === 0 ? (
        <p className="py-12 text-center text-sm text-[var(--muted-foreground)]">No assets match.</p>
      ) : (
        <div className="border border-[var(--border)] rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted-foreground)] border-b border-[var(--border)]">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium hidden md:table-cell">Serial / assigned</th>
                <th className="px-4 py-2 font-medium">Next date</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {assets.map((a) => {
                const next = nextDate(a);
                return (
                  <tr
                    key={a.id}
                    onClick={() => setEditing(a)}
                    className="cursor-pointer hover:bg-[var(--muted)]"
                    data-testid="asset-row"
                  >
                    <td className="px-4 py-3">
                      <button type="button" className="font-medium hover:underline text-left" onClick={() => setEditing(a)}>
                        {a.name}
                      </button>
                      {!a.clientVisible && (
                        <span className="ml-2 text-xs text-[var(--muted-foreground)]">(staff only)</span>
                      )}
                      {a.vendor && <p className="text-xs text-[var(--muted-foreground)]">{[a.vendor, a.model].filter(Boolean).join(" ")}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/contacts/companies/${a.company.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline"
                      >
                        {a.company.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{ASSET_TYPE_LABELS[a.type] ?? a.type}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-[var(--muted-foreground)]">
                      {[a.serialNumber, a.assignedTo].filter(Boolean).join(" · ")}
                      {a.seats != null && ` · ${a.seats} seats`}
                    </td>
                    <td className="px-4 py-3">
                      {next ? (
                        <span className={dueClass(next.date)}>
                          {next.label} {formatDay(next.date)}
                        </span>
                      ) : (
                        <span className="text-[var(--muted-foreground)]">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex px-2 py-0.5 rounded-full bg-[var(--muted)] text-xs font-medium">
                        {ASSET_STATUS_LABELS[a.status] ?? a.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {result && <Pagination page={page} totalPages={result.meta.totalPages} onPageChange={setPage} />}

      {editing && (
        <AssetFormModal
          asset={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {importing && <ImportAssetsModal onClose={() => setImporting(false)} onImported={load} />}
    </div>
  );
}
