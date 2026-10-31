"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { apiFetch, type PaginatedResponse } from "@/lib/api";
import { Pagination } from "@/components/pagination";
import { Skeleton } from "@/components/skeletons";
import {
  ANNOUNCEMENT_TYPE_LABELS,
  AUDIENCE_LABELS,
  INCIDENT_STATE_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  formatDateTime,
  severityStyle,
} from "@/lib/announcements";

interface AnnouncementRow {
  id: string;
  type: string;
  severity: string;
  status: string;
  incidentState: string | null;
  title: string;
  audienceType: string;
  audienceValue: string | null;
  publishAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  publicStatus: boolean;
  _count: { updates: number; tickets: number; audiences: number };
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-[var(--muted)] text-[var(--muted-foreground)]",
  scheduled: "bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200",
  published: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
  expired: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const selectClass = "px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";

export default function AnnouncementsPage(): React.ReactElement {
  const [rows, setRows] = useState<AnnouncementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (status) params.set("status", status);
      if (type) params.set("type", type);
      const res = await apiFetch<PaginatedResponse<AnnouncementRow>>(`/announcements?${params}`);
      setRows(res.data);
      setTotalPages(res.meta.totalPages);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load announcements");
    } finally {
      setLoading(false);
    }
  }, [page, status, type]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold">Announcements</h1>
        <Link
          href="/dashboard/announcements/new"
          className="flex items-center gap-2 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90"
        >
          <Plus size={16} />
          New announcement
        </Link>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className={selectClass}
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Type"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
          className={selectClass}
        >
          <option value="">All types</option>
          {Object.entries(ANNOUNCEMENT_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="mb-4 p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12">
          <Megaphone size={40} className="mx-auto text-[var(--muted-foreground)] mb-3" />
          <p className="text-[var(--muted-foreground)]">No announcements yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <Link
              key={a.id}
              href={`/dashboard/announcements/${a.id}`}
              className="block p-4 border border-[var(--border)] rounded-lg hover:bg-[var(--muted)] transition-colors"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLES[a.status] ?? STATUS_STYLES.draft}`}>
                  {STATUS_LABELS[a.status] ?? a.status}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--muted)]">
                  {ANNOUNCEMENT_TYPE_LABELS[a.type] ?? a.type}
                </span>
                {a.severity !== "info" && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${severityStyle(a.severity).badge}`}>
                    {SEVERITY_LABELS[a.severity]}
                  </span>
                )}
                {a.type === "incident" && a.incidentState && (
                  <span className="text-xs text-[var(--muted-foreground)]">{INCIDENT_STATE_LABELS[a.incidentState]}</span>
                )}
                {a.publicStatus && <span className="text-xs text-[var(--muted-foreground)]">Public</span>}
                <span className="ml-auto text-xs text-[var(--muted-foreground)]">
                  {a.status === "scheduled" && a.publishAt
                    ? `Publishes ${formatDateTime(a.publishAt)}`
                    : a.publishedAt
                      ? `Published ${formatDateTime(a.publishedAt)}`
                      : `Edited ${formatDateTime(a.updatedAt)}`}
                </span>
              </div>
              <h3 className="font-medium mt-1">{a.title}</h3>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                {AUDIENCE_LABELS[a.audienceType] ?? a.audienceType}
                {a.audienceValue ? `: ${a.audienceValue}` : ""}
                {a.audienceType === "companies" ? ` (${a._count.audiences})` : ""}
                {a._count.updates > 0 ? ` · ${a._count.updates} updates` : ""}
                {a._count.tickets > 0 ? ` · ${a._count.tickets} linked tickets` : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
      <div className="mt-4">
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>
    </div>
  );
}
