/**
 * Lifecycle rules for announcements: which status changes are allowed, what the
 * scheduler does next, and what a portal user may dismiss. Pure, so the state
 * machine is unit-tested without a database.
 */

export type AnnouncementAction = "publish" | "schedule" | "unpublish" | "expire";

export const ALLOWED_FROM: Record<AnnouncementAction, readonly string[]> = {
  publish: ["draft", "scheduled"],
  schedule: ["draft", "scheduled"],
  unpublish: ["published", "scheduled", "expired"],
  expire: ["published"],
};

/** Maintenance with no explicit expiry drops off this long after its window ends. */
export const MAINTENANCE_GRACE_MS = 60 * 60 * 1000;

export interface LifecycleFields {
  type: string;
  severity: string;
  status: string;
  incidentState: string | null;
  publishAt: Date | null;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  reminderSentAt?: Date | null;
}

export function canTransition(status: string, action: AnnouncementAction): boolean {
  return ALLOWED_FROM[action].includes(status);
}

export function isResolved(a: Pick<LifecycleFields, "incidentState" | "resolvedAt">): boolean {
  return a.incidentState === "resolved" || a.resolvedAt !== null;
}

/** When the announcement stops being shown: its own expiry, or an hour after a maintenance window. */
export function effectiveExpiry(a: Pick<LifecycleFields, "type" | "expiresAt" | "windowEnd">): Date | null {
  if (a.expiresAt) return a.expiresAt;
  if (a.type === "maintenance" && a.windowEnd) return new Date(a.windowEnd.getTime() + MAINTENANCE_GRACE_MS);
  return null;
}

/** What the scheduler should do with an announcement right now, if anything. */
export function dueAction(a: LifecycleFields, now: Date): "publish" | "expire" | null {
  if (a.status === "scheduled") {
    return a.publishAt && a.publishAt.getTime() <= now.getTime() ? "publish" : null;
  }
  if (a.status === "published") {
    const expiry = effectiveExpiry(a);
    return expiry && expiry.getTime() <= now.getTime() ? "expire" : null;
  }
  return null;
}

/** A maintenance reminder goes out once, within `hours` before the window starts. */
export function reminderDue(a: LifecycleFields, now: Date, hours: number): boolean {
  if (a.status !== "published" || a.type !== "maintenance") return false;
  if (a.reminderSentAt || !a.windowStart) return false;
  const until = a.windowStart.getTime() - now.getTime();
  return until > 0 && until <= hours * 3_600_000;
}

/** Critical announcements stay until they are resolved or expire; everything else can be dismissed. */
export function canDismiss(a: Pick<LifecycleFields, "severity" | "status" | "incidentState" | "resolvedAt">): boolean {
  if (a.severity !== "critical") return true;
  return a.status === "expired" || isResolved(a);
}

/** Banner material: unresolved incidents, and maintenance that is upcoming or under way. */
export function isBannerWorthy(a: LifecycleFields, now: Date): boolean {
  if (a.status !== "published") return false;
  if (a.type === "incident") return !isResolved(a);
  if (a.type === "maintenance") {
    const end = a.windowEnd ?? a.windowStart;
    return !end || end.getTime() > now.getTime();
  }
  return false;
}

/** Feed split: expired announcements and resolved incidents are history. */
export function isHistory(a: Pick<LifecycleFields, "type" | "status" | "incidentState" | "resolvedAt">): boolean {
  if (a.status === "expired") return true;
  return a.type === "incident" && isResolved(a);
}

/** Banner visibility for one user, given whether they dismissed it. */
export function showInBanner(a: LifecycleFields, dismissed: boolean, now: Date): boolean {
  if (!isBannerWorthy(a, now)) return false;
  return !dismissed || !canDismiss(a);
}
