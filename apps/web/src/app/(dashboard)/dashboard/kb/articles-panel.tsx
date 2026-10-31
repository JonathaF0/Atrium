"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KB_ARTICLE_STATUSES, KB_VISIBILITIES, KB_VISIBILITY_LABELS } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/api";
import { Pagination } from "@/components/pagination";
import { useDebounce } from "@/hooks/use-debounce";
import { useRowLink } from "@/lib/use-row-link";
import { KB_STATUS_LABELS, KB_STATUS_STYLES, flattenTree, formatDate } from "@/lib/kb";
import type { KbStaffArticleRow, KbStaffCollection } from "@/lib/kb";
import { inputClass, selectClass } from "./styles";

interface StaffMember {
  userId: string;
  name: string;
}

export function ArticlesPanel({ initialReview }: { initialReview: "" | "stale" }) {
  const rowLink = useRowLink();
  const [rows, setRows] = useState<KbStaffArticleRow[] | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [visibility, setVisibility] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [review, setReview] = useState<string>(initialReview);
  const [q, setQ] = useState("");
  const query: string = useDebounce(q, 250);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [collections, setCollections] = useState<KbStaffCollection[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiFetch<StaffMember[]>("/kb/staff").then(setStaff).catch(() => setStaff([]));
    apiFetch<KbStaffCollection[]>("/kb/collections").then(setCollections).catch(() => setCollections([]));
  }, []);

  useEffect(() => {
    setPage(1);
  }, [status, visibility, ownerId, collectionId, review, query]);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (status) params.set("status", status);
    if (visibility) params.set("visibility", visibility);
    if (ownerId) params.set("ownerId", ownerId);
    if (collectionId) params.set("collectionId", collectionId);
    if (review) params.set("review", review);
    if (query.trim()) params.set("q", query.trim());
    let cancelled = false;
    apiFetch<PaginatedResponse<KbStaffArticleRow>>(`/kb/articles?${params}`)
      .then((res) => {
        if (cancelled) return;
        setRows(res.data);
        setTotalPages(res.meta.totalPages || 1);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [page, status, visibility, ownerId, collectionId, review, query]);

  const now: number = Date.now();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search titles"
          aria-label="Search articles"
          className={`${inputClass} max-w-xs`}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass} aria-label="Status">
          <option value="">All statuses</option>
          {KB_ARTICLE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {KB_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value)} className={selectClass} aria-label="Visibility">
          <option value="">Any visibility</option>
          {KB_VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {KB_VISIBILITY_LABELS[v]}
            </option>
          ))}
        </select>
        <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)} className={selectClass} aria-label="Collection">
          <option value="">All collections</option>
          {flattenTree(collections).map((c) => (
            <option key={c.id} value={c.id}>
              {"  ".repeat(c.depth)}
              {c.name}
            </option>
          ))}
        </select>
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={selectClass} aria-label="Owner">
          <option value="">Any owner</option>
          {staff.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
        <select value={review} onChange={(e) => setReview(e.target.value)} className={selectClass} aria-label="Review">
          <option value="">Any review date</option>
          <option value="stale">Review overdue</option>
          <option value="upcoming">Review due in 30 days</option>
        </select>
      </div>

      {failed && !rows ? (
        <p className="text-sm text-[var(--muted-foreground)]">Couldn&apos;t load articles.</p>
      ) : !rows ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)] py-8 text-center">No articles match.</p>
      ) : (
        <div className="border border-[var(--border)] rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[var(--muted-foreground)] border-b border-[var(--border)]">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Visibility</th>
                <th className="px-4 py-2 font-medium hidden md:table-cell">Collection</th>
                <th className="px-4 py-2 font-medium hidden md:table-cell">Owner</th>
                <th className="px-4 py-2 font-medium">Review by</th>
                <th className="px-4 py-2 font-medium hidden lg:table-cell text-right">Views</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((a) => {
                const overdue: boolean = !!a.reviewBy && new Date(a.reviewBy).getTime() < now && a.status !== "archived";
                return (
                  <tr key={a.id} {...rowLink(`/dashboard/kb/articles/${a.id}`)} className="cursor-pointer hover:bg-[var(--muted)]">
                    <td className="px-4 py-2">
                      <Link href={`/dashboard/kb/articles/${a.id}`} className="font-medium hover:underline">
                        {a.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${KB_STATUS_STYLES[a.status]}`}>
                        {KB_STATUS_LABELS[a.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-[var(--muted-foreground)]">{KB_VISIBILITY_LABELS[a.visibility] ?? a.visibility}</td>
                    <td className="px-4 py-2 text-[var(--muted-foreground)] hidden md:table-cell">{a.collection?.name ?? "—"}</td>
                    <td className="px-4 py-2 text-[var(--muted-foreground)] hidden md:table-cell">{a.owner?.name ?? "—"}</td>
                    <td className={`px-4 py-2 ${overdue ? "text-red-600 font-medium" : "text-[var(--muted-foreground)]"}`}>
                      {formatDate(a.reviewBy)}
                    </td>
                    <td className="px-4 py-2 text-right text-[var(--muted-foreground)] hidden lg:table-cell">{a.viewCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
}
