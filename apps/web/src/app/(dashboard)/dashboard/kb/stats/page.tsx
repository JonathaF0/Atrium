"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { StatCardSkeleton } from "@/components/skeletons";
import { KB_STATUS_LABELS, formatDate } from "@/lib/kb";
import type { KbArticleStatus } from "@atrium/shared";

interface Stats {
  totals: {
    byStatus: Partial<Record<KbArticleStatus, number>>;
    views: number;
    helpfulYes: number;
    helpfulNo: number;
    deflected: number;
    stale: number;
  };
  articles: Array<{
    id: string;
    title: string;
    viewCount: number;
    helpfulYes: number;
    helpfulNo: number;
    deflections: { viewed: number; deflected: number; submitted: number };
  }>;
  stale: Array<{ id: string; title: string; status: KbArticleStatus; reviewBy: string | null; owner: { name: string } | null }>;
}

function helpfulRate(yes: number, no: number): string {
  const total: number = yes + no;
  return total === 0 ? "—" : `${Math.round((yes / total) * 100)}%`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-[var(--border)] rounded-xl p-4">
      <p className="text-xs text-[var(--muted-foreground)]">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
    </div>
  );
}

export default function KbStatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiFetch<Stats>("/kb/stats").then(setStats).catch(() => setFailed(true));
  }, []);

  return (
    <div className="space-y-6">
      <Link href="/dashboard/kb" className="text-sm text-[var(--muted-foreground)] hover:underline">
        ‹ Knowledge base
      </Link>
      <h1 className="text-2xl font-bold">Knowledge base stats</h1>

      {failed ? (
        <p className="text-sm text-[var(--muted-foreground)]">Couldn&apos;t load stats.</p>
      ) : !stats ? (
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
            <Stat label="Published articles" value={stats.totals.byStatus.published ?? 0} />
            <Stat label="Views" value={stats.totals.views} />
            <Stat label="Found helpful" value={helpfulRate(stats.totals.helpfulYes, stats.totals.helpfulNo)} />
            <Stat label="Tickets avoided" value={stats.totals.deflected} />
          </div>
          <p className="text-xs text-[var(--muted-foreground)]">
            {(Object.keys(KB_STATUS_LABELS) as KbArticleStatus[])
              .map((s) => `${KB_STATUS_LABELS[s]}: ${stats.totals.byStatus[s] ?? 0}`)
              .join(" · ")}
          </p>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Published articles</h2>
            {stats.articles.length === 0 ? (
              <p className="text-sm text-[var(--muted-foreground)]">Nothing published yet.</p>
            ) : (
              <div className="border border-[var(--border)] rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-[var(--muted-foreground)] border-b border-[var(--border)]">
                    <tr>
                      <th className="px-4 py-2 font-medium">Article</th>
                      <th className="px-4 py-2 font-medium text-right">Views</th>
                      <th className="px-4 py-2 font-medium text-right">Helpful</th>
                      <th className="px-4 py-2 font-medium text-right">Not helpful</th>
                      <th className="px-4 py-2 font-medium text-right">Suggested and opened</th>
                      <th className="px-4 py-2 font-medium text-right">Ticket avoided</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {stats.articles.map((a) => (
                      <tr key={a.id}>
                        <td className="px-4 py-2">
                          <Link href={`/dashboard/kb/articles/${a.id}`} className="hover:underline">
                            {a.title}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-right">{a.viewCount}</td>
                        <td className="px-4 py-2 text-right">{a.helpfulYes}</td>
                        <td className="px-4 py-2 text-right">{a.helpfulNo}</td>
                        <td className="px-4 py-2 text-right">{a.deflections.viewed}</td>
                        <td className="px-4 py-2 text-right">{a.deflections.deflected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Due for review ({stats.totals.stale})</h2>
            {stats.stale.length === 0 ? (
              <p className="text-sm text-[var(--muted-foreground)]">Every article is within its review date.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl">
                {stats.stale.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <Link href={`/dashboard/kb/articles/${a.id}`} className="hover:underline truncate">
                      {a.title}
                    </Link>
                    <span className="text-xs text-red-600 shrink-0">
                      {formatDate(a.reviewBy)}
                      {a.owner ? ` · ${a.owner.name}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
