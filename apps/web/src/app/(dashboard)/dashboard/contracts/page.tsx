"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useCachedApi } from "@/lib/cached";
import { useRowLink } from "@/lib/use-row-link";
import { useToast } from "@/components/toast";
import { Pagination } from "@/components/pagination";
import { ClientItemSkeleton } from "@/components/skeletons";
import { inputClass } from "../contacts/shared";
import { ContractForm } from "./contract-form";
import { UsageBar } from "./usage-bar";
import { CONTRACT_STATUSES, CONTRACT_STATUS_LABELS, CONTRACT_TYPE_LABELS, formatDay } from "./shared";
import type { Contract } from "./shared";

interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export default function ContractsPage() {
  const router = useRouter();
  const rowLink = useRowLink();
  const searchParams = useSearchParams();
  const { error: showError, success } = useToast();
  const companies = useCachedApi<{ data: { id: string; name: string }[] }>("/companies?limit=100")?.data ?? [];
  const [companyId, setCompanyId] = useState(searchParams.get("companyId") ?? "");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Paginated<Contract> | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (companyId) params.set("companyId", companyId);
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    try {
      setResult(await apiFetch<Paginated<Contract>>(`/contracts?${params.toString()}`));
    } catch (err) {
      console.error(err);
      showError("Failed to load contracts");
    } finally {
      setLoading(false);
    }
  }, [page, companyId, status, q, showError]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const contracts = result?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Contracts</h1>
          <p className="text-sm text-[var(--muted-foreground)]">Service agreements, retainers and blocks of hours.</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90"
        >
          <Plus size={16} /> New contract
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search contracts"
          placeholder="Search contracts..."
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          maxLength={200}
          className={`${inputClass} max-w-xs`}
        />
        <select
          aria-label="Company"
          value={companyId}
          onChange={(e) => {
            setCompanyId(e.target.value);
            setPage(1);
          }}
          className={`${inputClass} w-auto`}
        >
          <option value="">All companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className={`${inputClass} w-auto`}
        >
          <option value="">Any status</option>
          {CONTRACT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CONTRACT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="space-y-2">
          <ClientItemSkeleton />
          <ClientItemSkeleton />
        </div>
      ) : contracts.length === 0 ? (
        <p className="py-12 text-center text-sm text-[var(--muted-foreground)]">No contracts yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl">
          {contracts.map((c) => (
            <li
              key={c.id}
              {...rowLink(`/dashboard/contracts/${c.id}`)}
              className="cursor-pointer grid gap-3 md:grid-cols-[2fr_1fr_1.5fr] items-center px-4 py-3 text-sm hover:bg-[var(--muted)]"
            >
              <div className="min-w-0">
                <Link href={`/dashboard/contracts/${c.id}`} className="font-medium hover:underline">
                  {c.name}
                </Link>
                <p className="text-xs text-[var(--muted-foreground)] truncate">
                  {c.company.name} · {CONTRACT_TYPE_LABELS[c.type] ?? c.type}
                </p>
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">
                <span className="inline-flex px-2 py-0.5 rounded-full bg-[var(--muted)] font-medium text-[var(--foreground)] mr-2">
                  {CONTRACT_STATUS_LABELS[c.status] ?? c.status}
                </span>
                {c.endsAt ? `until ${formatDay(c.endsAt)}` : "open-ended"}
                {c.autoRenew && " · auto-renews"}
              </div>
              <div>{c.usage && <UsageBar usage={c.usage} />}</div>
            </li>
          ))}
        </ul>
      )}

      {result && <Pagination page={page} totalPages={result.meta.totalPages} onPageChange={setPage} />}

      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCreating(false);
          }}
        >
          <div className="bg-[var(--background)] rounded-xl shadow-lg w-full max-w-2xl mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold">New contract</h3>
            <ContractForm
              onCancel={() => setCreating(false)}
              onSaved={(saved) => {
                success("Contract created");
                router.push(`/dashboard/contracts/${saved.id}`);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
