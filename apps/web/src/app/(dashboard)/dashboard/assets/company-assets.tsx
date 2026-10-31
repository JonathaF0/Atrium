"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { AssetFormModal } from "./asset-form-modal";
import { ASSET_STATUS_LABELS, ASSET_TYPE_LABELS, dueClass, formatDay, nextDate } from "./shared";
import type { Asset, Paginated } from "./shared";

const headingClass = "text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]";

/** "Assets" section of a company page in Contacts. */
export function CompanyAssets({ company }: { company: { id: string; name: string } }) {
  const [assets, setAssets] = useState<Paginated<Asset> | null>(null);
  const [editing, setEditing] = useState<Asset | "new" | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setAssets(await apiFetch<Paginated<Asset>>(`/assets?companyId=${encodeURIComponent(company.id)}&limit=100`));
    } catch (err) {
      console.error(err);
    }
  }, [company.id]);

  useEffect(() => {
    load();
  }, [load]);

  const list = assets?.data ?? [];
  return (
    <section aria-label="Assets">
      <div className="flex items-center justify-between mb-2">
        <h2 className={headingClass}>Assets</h2>
        <div className="flex items-center gap-3">
          {(assets?.meta.total ?? 0) > list.length && (
            <Link href={`/dashboard/assets?companyId=${company.id}`} className="text-sm text-[var(--muted-foreground)] hover:underline">
              View all
            </Link>
          )}
          <button
            onClick={() => setEditing("new")}
            className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            + Add asset
          </button>
        </div>
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">No assets yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl">
          {list.map((a) => {
            const next = nextDate(a);
            return (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <button type="button" onClick={() => setEditing(a)} className="font-medium hover:underline text-left">
                    {a.name}
                  </button>
                  <p className="text-xs text-[var(--muted-foreground)] truncate">
                    {[ASSET_TYPE_LABELS[a.type], a.serialNumber, a.assignedTo].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  {next && (
                    <p className={`text-xs ${dueClass(next.date)}`}>
                      {next.label} {formatDay(next.date)}
                    </p>
                  )}
                  <span className="text-xs text-[var(--muted-foreground)]">{ASSET_STATUS_LABELS[a.status] ?? a.status}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <AssetFormModal
          asset={editing === "new" ? undefined : editing}
          company={company}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </section>
  );
}
