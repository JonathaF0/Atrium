"use client";

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/api";
import { downloadCsv } from "@/lib/download";
import { useToast } from "@/components/toast";
import { Pagination } from "@/components/pagination";

interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  targetType: string;
  targetId: string | null;
  summary: string | null;
  ipAddress: string | null;
  metadata: unknown;
}

interface Actor {
  id: string;
  name: string | null;
  email: string | null;
}

/** Friendly names for action groups (the part of an action before the first dot). Unknown groups get a readable fallback. */
const ACTION_GROUP_LABELS: Record<string, string> = {
  auth: "Sign-ins and account security",
  member: "Members and permissions",
  security: "Workspace security",
  export: "Exports",
  invoice: "Invoices",
  recurring_invoice: "Recurring billing",
  payments: "Payments",
  billing: "Plan and subscription",
  ticket: "Tickets",
  helpdesk: "Helpdesk settings",
  kb: "Knowledge base",
  client_doc: "Client documentation",
  estimate: "Estimates",
  contract: "Contracts",
  asset: "Assets",
  announcement: "Announcements",
  contact: "Contacts",
  workspace: "Workspace",
  report: "Reports",
};

const TARGET_TYPE_LABELS: Record<string, string> = {
  sso_provider: "SSO provider",
  kb_article: "Knowledge base article",
  kb_collection: "Knowledge base collection",
  client_doc: "Client document",
  service_settings: "Service settings",
  recurring_invoice: "Recurring invoice",
};

/** "recurring_invoice" -> "Recurring invoice" */
function readable(value: string): string {
  const text: string = value.replace(/[_.]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const inputClass = "px-3 py-2 text-sm border border-[var(--border)] rounded-lg bg-[var(--background)]";

interface Filters {
  action: string;
  actorId: string;
  targetType: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { action: "", actorId: "", targetType: "", from: "", to: "" };

function query(filters: Filters, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams(extra);
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  return qs.toString();
}

export default function AuditLogPage() {
  const { error: showError } = useToast();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [facets, setFacets] = useState<{ actionGroups: string[]; targetTypes: string[] }>({ actionGroups: [], targetTypes: [] });
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<PaginatedResponse<AuditEntry>>(`/audit-log?${query(filters, { page: String(page), limit: "50" })}`);
      setEntries(res.data);
      setTotalPages(res.meta.totalPages);
      setTotal(res.meta.total);
    } catch (err) {
      if (err instanceof Error && "status" in err && (err as { status: number }).status === 403) setForbidden(true);
      else showError(err instanceof Error ? err.message : "Failed to load the audit log");
    } finally {
      setLoading(false);
    }
  }, [filters, page, showError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiFetch<Actor[]>("/audit-log/actors").then(setActors).catch(() => setActors([]));
    apiFetch<{ actionGroups: string[]; targetTypes: string[] }>("/audit-log/facets")
      .then(setFacets)
      .catch(() => setFacets({ actionGroups: [], targetTypes: [] }));
  }, []);

  const update = (patch: Partial<Filters>): void => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    try {
      await downloadCsv(`/audit-log/export?${query(filters)}`);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  if (forbidden) {
    return <p className="text-sm text-[var(--muted-foreground)]">Only owners and admins can see the audit log.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Audit log</h2>
          <p className="text-sm text-[var(--muted-foreground)]">Sign-ins, permission changes, exports and billing actions in this workspace.</p>
        </div>
        <button
          onClick={exportCsv}
          disabled={exporting}
          className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--muted)] disabled:opacity-50"
        >
          <Download size={14} /> {exporting ? "Exporting..." : "Export CSV"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-end">
        <label className="text-xs text-[var(--muted-foreground)] flex flex-col gap-1">
          Action
          <select aria-label="Action" className={inputClass} value={filters.action} onChange={(e) => update({ action: e.target.value })}>
            <option value="">All actions</option>
            {facets.actionGroups.map((g) => (
              <option key={g} value={`${g}.`}>{ACTION_GROUP_LABELS[g] ?? readable(g)}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--muted-foreground)] flex flex-col gap-1">
          Actor
          <select aria-label="Actor" className={inputClass} value={filters.actorId} onChange={(e) => update({ actorId: e.target.value })}>
            <option value="">Anyone</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>{a.name ? `${a.name} (${a.email ?? ""})` : a.email ?? a.id}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--muted-foreground)] flex flex-col gap-1">
          Target type
          <select aria-label="Target type" className={inputClass} value={filters.targetType} onChange={(e) => update({ targetType: e.target.value })}>
            <option value="">Any</option>
            {facets.targetTypes.map((t) => (
              <option key={t} value={t}>{TARGET_TYPE_LABELS[t] ?? readable(t)}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--muted-foreground)] flex flex-col gap-1">
          From
          <input aria-label="From" type="date" className={inputClass} value={filters.from} onChange={(e) => update({ from: e.target.value })} />
        </label>
        <label className="text-xs text-[var(--muted-foreground)] flex flex-col gap-1">
          To
          <input aria-label="To" type="date" className={inputClass} value={filters.to} onChange={(e) => update({ to: e.target.value })} />
        </label>
        {JSON.stringify(filters) !== JSON.stringify(EMPTY) && (
          <button onClick={() => update(EMPTY)} className="text-sm text-[var(--primary)] hover:underline pb-2">
            Clear filters
          </button>
        )}
      </div>

      <p className="text-xs text-[var(--muted-foreground)]">{total} entries</p>

      <div className="border border-[var(--border)] rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--muted)] text-left">
              <th className="px-3 py-2 font-medium whitespace-nowrap">Time</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-[var(--muted-foreground)]">Loading...</td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-[var(--muted-foreground)]">No entries match these filters.</td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id} className="border-t border-[var(--border)] align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-[var(--muted-foreground)]">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    {e.actorName ?? e.actorEmail ?? (e.actorId ? "Deleted user" : "System")}
                    {e.actorName && e.actorEmail && <span className="block text-xs text-[var(--muted-foreground)]">{e.actorEmail}</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{e.action}</td>
                  <td className="px-3 py-2">
                    <span>{e.summary}</span>
                    {e.ipAddress && <span className="block text-xs text-[var(--muted-foreground)]">{e.ipAddress}</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
