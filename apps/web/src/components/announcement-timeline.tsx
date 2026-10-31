"use client";

import { Markdown } from "@/components/markdown";
import { INCIDENT_STATE_LABELS, formatDateTime, type AnnouncementUpdateItem } from "@/lib/announcements";

/** Incident updates, newest first. */
export function AnnouncementTimeline({ updates }: { updates: AnnouncementUpdateItem[] }): React.ReactElement | null {
  if (updates.length === 0) return null;
  const ordered = [...updates].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return (
    <ol className="mt-4 border-l-2 border-[var(--border)] pl-4 space-y-4" aria-label="Updates" data-testid="announcement-timeline">
      {ordered.map((u, i) => (
        <li key={u.id ?? `${u.createdAt}-${i}`} className="relative">
          <span className="absolute -left-[1.3rem] top-1.5 h-2.5 w-2.5 rounded-full bg-[var(--primary)]" aria-hidden="true" />
          <p className="text-xs text-[var(--muted-foreground)]">
            {u.state && (
              <span className="font-semibold text-[var(--foreground)] mr-2">{INCIDENT_STATE_LABELS[u.state] ?? u.state}</span>
            )}
            {formatDateTime(u.createdAt)}
          </p>
          <Markdown source={u.body} />
        </li>
      ))}
    </ol>
  );
}
