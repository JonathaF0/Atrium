"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LifeBuoy, Plus, Search } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatRelativeTime } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { Pagination } from "@/components/pagination";
import { ProjectCardSkeleton } from "@/components/skeletons";
import { StatusBadge } from "@/lib/tickets";

interface PortalTicket {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  lastActivityAt: string;
  requesterName: string | null;
  own: boolean;
  category: { id: string; name: string; color: string } | null;
}

interface ListResponse {
  data: PortalTicket[];
  meta: { totalPages: number };
  companyAdmin: boolean;
}

const FILTERS = [
  { value: "active", label: "Open" },
  { value: "done", label: "Resolved & closed" },
  { value: "", label: "All" },
];

export default function PortalTicketsPage(): React.ReactElement {
  const [tickets, setTickets] = useState<PortalTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("active");
  const [scope, setScope] = useState<"company" | "mine">("company");
  const [companyAdmin, setCompanyAdmin] = useState(false);
  const [search, setSearch] = useState("");
  const q = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (status) params.set("status", status);
      if (q) params.set("q", q);
      if (scope === "mine") params.set("scope", "mine");
      const res = await apiFetch<ListResponse>(`/tickets/mine?${params}`);
      if (mine !== requestId.current) return;
      setTickets(res.data);
      setTotalPages(res.meta.totalPages);
      setCompanyAdmin(res.companyAdmin);
      setError("");
    } catch (err) {
      if (mine === requestId.current) setError(err instanceof Error ? err.message : "Failed to load requests");
    } finally {
      if (mine === requestId.current) setLoading(false);
    }
  }, [page, status, q, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold">Support</h1>
        <Link
          href="/portal/tickets/new"
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium hover:opacity-90"
        >
          <Plus size={16} />
          New request
        </Link>
      </div>

      {error && <div className="mb-4 p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1 border border-[var(--border)] rounded-lg p-1" role="tablist" aria-label="Status filter">
          {FILTERS.map((f) => (
            <button
              key={f.value || "all"}
              role="tab"
              aria-selected={status === f.value}
              onClick={() => {
                setStatus(f.value);
                setPage(1);
              }}
              className={`px-3 py-1 text-sm rounded-md ${status === f.value ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {companyAdmin && (
          <select
            aria-label="Whose requests"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as "company" | "mine");
              setPage(1);
            }}
            className="px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
          >
            <option value="company">Everyone at my company</option>
            <option value="mine">Only mine</option>
          </select>
        )}
        <div className="relative w-full sm:max-w-xs sm:ml-auto">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search requests..."
            maxLength={200}
            className="w-full pl-9 pr-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          <ProjectCardSkeleton />
          <ProjectCardSkeleton />
        </div>
      ) : tickets.length === 0 ? (
        <div className="text-center py-16 text-[var(--muted-foreground)]">
          <LifeBuoy size={40} className="mx-auto mb-3 opacity-40" />
          <p>No requests here yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {tickets.map((t) => (
            <Link
              key={t.id}
              href={`/portal/tickets/${t.id}`}
              className="block p-4 border border-[var(--border)] rounded-lg hover:bg-[var(--muted)] transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-[var(--muted-foreground)]">{t.reference}</div>
                  <h3 className="font-medium truncate">{t.subject}</h3>
                </div>
                <StatusBadge status={t.status} />
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--muted-foreground)]">
                {t.category && <span>{t.category.name}</span>}
                {!t.own && t.requesterName && <span>From {t.requesterName}</span>}
                <span>Updated {formatRelativeTime(t.lastActivityAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className="mt-6">
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>
    </div>
  );
}
