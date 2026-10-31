import { ASSET_TYPES, ASSET_TYPE_LABELS } from "@atrium/shared";
import type { AssetType } from "@atrium/shared";

export { ASSET_TYPES, ASSET_TYPE_LABELS };
export type { AssetType };

export const ASSET_STATUSES = ["active", "retired", "expired"] as const;
export const ASSET_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  retired: "Retired",
  expired: "Expired",
};

export const EXPIRING_CHIPS = [30, 60, 90] as const;

export interface Asset {
  id: string;
  companyId: string;
  type: AssetType;
  name: string;
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  assignedTo: string | null;
  status: string;
  seats: number | null;
  purchaseDate: string | null;
  warrantyEndsAt: string | null;
  renewsAt: string | null;
  notes: string | null;
  externalSource: string | null;
  externalId: string | null;
  metadata: Record<string, string | number | boolean> | null;
  clientVisible: boolean;
  company: { id: string; name: string };
  _count?: { tickets: number };
}

export interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Mar 1, 2027" for a stored date, in UTC (dates are stored as midnight UTC). */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "2027-03-01" for a date input. */
export function toDateInput(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

/** Whole days from now until the date (negative when past). */
export function daysUntil(value: string, now: number = Date.now()): number {
  return Math.ceil((new Date(value).getTime() - now) / DAY_MS);
}

/** The earliest of warranty end and renewal, with what it is. */
export function nextDate(asset: Pick<Asset, "warrantyEndsAt" | "renewsAt">): { label: string; date: string } | null {
  const dates = [
    asset.renewsAt ? { label: "Renews", date: asset.renewsAt } : null,
    asset.warrantyEndsAt ? { label: "Warranty ends", date: asset.warrantyEndsAt } : null,
  ].filter((d): d is { label: string; date: string } => d !== null);
  dates.sort((a, b) => a.date.localeCompare(b.date));
  return dates[0] ?? null;
}

/** Tailwind classes for a date chip: red when past, amber within 30 days. */
export function dueClass(date: string, now: number = Date.now()): string {
  const days = daysUntil(date, now);
  if (days < 0) return "text-red-600";
  if (days <= 30) return "text-amber-600";
  return "text-[var(--muted-foreground)]";
}
