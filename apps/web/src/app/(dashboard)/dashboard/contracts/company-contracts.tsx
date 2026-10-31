"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { ContractForm } from "./contract-form";
import { UsageBar } from "./usage-bar";
import { CONTRACT_STATUS_LABELS, CONTRACT_TYPE_LABELS, formatDay } from "./shared";
import type { Contract } from "./shared";

const headingClass = "text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]";

/** "Contracts" section of a company page in Contacts. */
export function CompanyContracts({ company }: { company: { id: string; name: string } }) {
  const router = useRouter();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await apiFetch<{ data: Contract[] }>(`/contracts?companyId=${encodeURIComponent(company.id)}&limit=100`);
      setContracts(res.data);
    } catch (err) {
      console.error(err);
    }
  }, [company.id]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section aria-label="Contracts">
      <div className="flex items-center justify-between mb-2">
        <h2 className={headingClass}>Contracts</h2>
        <button
          onClick={() => setCreating(true)}
          className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          + Add contract
        </button>
      </div>
      {contracts.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">No contracts yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl">
          {contracts.map((c) => (
            <li key={c.id} className="grid gap-2 sm:grid-cols-[1fr_1fr] items-center px-4 py-3 text-sm">
              <div className="min-w-0">
                <Link href={`/dashboard/contracts/${c.id}`} className="font-medium hover:underline">
                  {c.name}
                </Link>
                <p className="text-xs text-[var(--muted-foreground)]">
                  {CONTRACT_TYPE_LABELS[c.type] ?? c.type} · {CONTRACT_STATUS_LABELS[c.status] ?? c.status}
                  {c.endsAt ? ` · until ${formatDay(c.endsAt)}` : ""}
                </p>
              </div>
              <div>{c.usage && <UsageBar usage={c.usage} />}</div>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCreating(false);
          }}
        >
          <div className="bg-[var(--background)] rounded-xl shadow-lg w-full max-w-2xl mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold">New contract for {company.name}</h3>
            <ContractForm
              company={company}
              onCancel={() => setCreating(false)}
              onSaved={(saved) => router.push(`/dashboard/contracts/${saved.id}`)}
            />
          </div>
        </div>
      )}
    </section>
  );
}
