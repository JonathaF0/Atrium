export interface AnnouncementUpdateItem {
  id?: string;
  state: string | null;
  body: string;
  createdAt: string;
}

/** An announcement as the portal endpoints return it. */
export interface PortalAnnouncement {
  id: string;
  type: string;
  severity: string;
  status: string;
  incidentState: string | null;
  title: string;
  body: string;
  impact: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  publishedAt: string | null;
  resolvedAt: string | null;
  postmortem: string | null;
  updates: AnnouncementUpdateItem[];
  read: boolean;
  dismissed: boolean;
  canDismiss: boolean;
}

export const ANNOUNCEMENT_TYPE_LABELS: Record<string, string> = {
  general: "Announcement",
  maintenance: "Maintenance",
  incident: "Incident",
  security: "Security",
};

export const SEVERITY_LABELS: Record<string, string> = {
  info: "Info",
  minor: "Minor",
  major: "Major",
  critical: "Critical",
};

export const INCIDENT_STATE_LABELS: Record<string, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

export const AUDIENCE_LABELS: Record<string, string> = {
  all: "All clients",
  companies: "Selected companies",
  contracts: "Companies with a contract",
  assets: "Companies with an asset",
};

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  published: "Published",
  expired: "Expired",
};

/** Banner/badge colours by severity; critical and major read as alerts. */
export const SEVERITY_STYLES: Record<string, { box: string; badge: string }> = {
  info: {
    box: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100",
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200",
  },
  minor: {
    box: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  },
  major: {
    box: "border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-100",
    badge: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200",
  },
  critical: {
    box: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100",
    badge: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
  },
};

export function severityStyle(severity: string): { box: string; badge: string } {
  return SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.info;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatWindow(start: string | null, end: string | null): string | null {
  if (!start) return null;
  return end ? `${formatDateTime(start)} – ${formatDateTime(end)}` : formatDateTime(start);
}

/** One line under the title: incident state, or the maintenance window. */
export function announcementSubtitle(a: Pick<PortalAnnouncement, "type" | "incidentState" | "windowStart" | "windowEnd">): string | null {
  if (a.type === "incident" && a.incidentState) return INCIDENT_STATE_LABELS[a.incidentState] ?? a.incidentState;
  if (a.type === "maintenance") return formatWindow(a.windowStart, a.windowEnd);
  return null;
}
