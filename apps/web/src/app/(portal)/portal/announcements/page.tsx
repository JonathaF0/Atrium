"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Megaphone } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { Skeleton } from "@/components/skeletons";
import { AnnouncementTimeline } from "@/components/announcement-timeline";
import {
  ANNOUNCEMENT_TYPE_LABELS,
  SEVERITY_LABELS,
  announcementSubtitle,
  formatDateTime,
  severityStyle,
  type PortalAnnouncement,
} from "@/lib/announcements";

interface Feed {
  active: PortalAnnouncement[];
  history: PortalAnnouncement[];
  unread: number;
}

function AnnouncementCard({ a, highlighted }: { a: PortalAnnouncement; highlighted: boolean }): React.ReactElement {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [highlighted]);
  const subtitle = announcementSubtitle(a);
  return (
    <article
      ref={ref}
      id={`announcement-${a.id}`}
      className={`border rounded-lg p-4 ${highlighted ? "border-[var(--primary)]" : "border-[var(--border)]"}`}
      data-testid="announcement-card"
    >
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--muted)]">{ANNOUNCEMENT_TYPE_LABELS[a.type] ?? a.type}</span>
        {a.severity !== "info" && (
          <span className={`text-xs px-2 py-0.5 rounded-full ${severityStyle(a.severity).badge}`}>
            {SEVERITY_LABELS[a.severity] ?? a.severity}
          </span>
        )}
        {!a.read && <span className="text-xs font-semibold text-[var(--primary)]">New</span>}
        <span className="text-xs text-[var(--muted-foreground)] ml-auto">{formatDateTime(a.publishedAt)}</span>
      </div>
      <h2 className="font-semibold text-lg">{a.title}</h2>
      {subtitle && <p className="text-sm text-[var(--muted-foreground)]">{subtitle}</p>}
      {a.impact && (
        <p className="text-sm mt-1">
          <span className="font-medium">Impact:</span> {a.impact}
        </p>
      )}
      <div className="mt-3">
        <Markdown source={a.body} />
      </div>
      <AnnouncementTimeline updates={a.updates} />
      {a.postmortem && (
        <div className="mt-4 rounded-lg bg-[var(--muted)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide mb-1">Postmortem</p>
          <Markdown source={a.postmortem} />
        </div>
      )}
    </article>
  );
}

export default function PortalAnnouncementsPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const focusId = searchParams.get("id");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<Feed>("/announcements/mine")
      .then((data) => {
        setFeed(data);
        // Seen once listed; preview mode is read-only, so failures are ignored.
        for (const a of [...data.active, ...data.history]) {
          if (!a.read && a.status === "published") {
            apiFetch(`/announcements/mine/${a.id}/read`, { method: "POST" }).catch(() => {});
          }
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load announcements"));
  }, []);

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Announcements</h1>
      {error && <div className="mb-6 p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}
      {!feed && !error && (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}
      {feed && (
        <>
          {feed.active.length === 0 && feed.history.length === 0 && (
            <div className="text-center py-12">
              <Megaphone size={40} className="mx-auto text-[var(--muted-foreground)] mb-3" />
              <p className="text-[var(--muted-foreground)]">No announcements right now.</p>
            </div>
          )}
          {feed.active.length > 0 && (
            <div className="space-y-3" data-testid="announcements-active">
              {feed.active.map((a) => (
                <AnnouncementCard key={a.id} a={a} highlighted={a.id === focusId} />
              ))}
            </div>
          )}
          {feed.history.length > 0 && (
            <>
              <h2 className="text-lg font-semibold mt-10 mb-3">History</h2>
              <div className="space-y-3" data-testid="announcements-history">
                {feed.history.map((a) => (
                  <AnnouncementCard key={a.id} a={a} highlighted={a.id === focusId} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
