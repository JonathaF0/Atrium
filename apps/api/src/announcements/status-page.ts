import { isResolved } from "./announcement-state";

/** History window on the public status page. */
export const STATUS_HISTORY_DAYS = 30;

export interface StatusSource {
  id: string;
  type: string;
  severity: string;
  status: string;
  incidentState: string | null;
  title: string;
  body: string;
  impact: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  publishedAt: Date | null;
  resolvedAt: Date | null;
  postmortem: string | null;
  publicStatus: boolean;
  audienceType: string;
  updates: { state: string | null; body: string; createdAt: Date }[];
}

export interface StatusItem {
  id: string;
  type: string;
  severity: string;
  incidentState: string | null;
  title: string;
  body: string;
  impact: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  publishedAt: string | null;
  resolvedAt: string | null;
  postmortem: string | null;
  updates: { state: string | null; body: string; createdAt: string }[];
}

export interface StatusPage {
  activeIncidents: StatusItem[];
  maintenance: StatusItem[];
  history: StatusItem[];
}

/**
 * Only announcements meant for everyone may appear publicly. Checked here as
 * well as on write, so an audience change after the fact can never leak.
 */
export function isPubliclyVisible(a: Pick<StatusSource, "publicStatus" | "audienceType" | "status">): boolean {
  return a.publicStatus && a.audienceType === "all" && (a.status === "published" || a.status === "expired");
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** The public shape: no audience, author or internal fields. */
export function toStatusItem(a: StatusSource): StatusItem {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    incidentState: a.incidentState,
    title: a.title,
    body: a.body,
    impact: a.impact,
    windowStart: iso(a.windowStart),
    windowEnd: iso(a.windowEnd),
    publishedAt: iso(a.publishedAt),
    resolvedAt: iso(a.resolvedAt),
    postmortem: a.postmortem,
    updates: a.updates.map((u) => ({ state: u.state, body: u.body, createdAt: u.createdAt.toISOString() })),
  };
}

export function buildStatusPage(items: StatusSource[], now: Date): StatusPage {
  const since = now.getTime() - STATUS_HISTORY_DAYS * 86_400_000;
  const page: StatusPage = { activeIncidents: [], maintenance: [], history: [] };
  const sorted = [...items]
    .filter(isPubliclyVisible)
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  for (const a of sorted) {
    const published = a.status === "published";
    if (published && a.type === "incident" && !isResolved(a)) {
      page.activeIncidents.push(toStatusItem(a));
    } else if (published && a.type === "maintenance" && (a.windowEnd ?? a.windowStart ?? now).getTime() >= now.getTime()) {
      page.maintenance.push(toStatusItem(a));
    } else {
      const at = (a.resolvedAt ?? a.publishedAt)?.getTime() ?? 0;
      if (at >= since) page.history.push(toStatusItem(a));
    }
  }
  return page;
}
