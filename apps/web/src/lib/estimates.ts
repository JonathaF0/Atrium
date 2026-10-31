// Small helpers shared by the catalog, estimate builder and portal estimate pages.

export const BILLING_TYPE_LABELS: Record<string, string> = {
  hourly: "Hourly",
  fixed: "Fixed",
  recurring: "Recurring",
};

export const INTERVAL_LABELS: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

export const INTERVAL_SUFFIX: Record<string, string> = {
  weekly: "/ week",
  monthly: "/ month",
  quarterly: "/ quarter",
  yearly: "/ year",
};

export const ESTIMATE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  changes_requested: "Changes requested",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  superseded: "Superseded",
  converted: "Converted",
};

export const ESTIMATE_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-500/15 text-gray-700 dark:text-gray-300",
  sent: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  viewed: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  changes_requested: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  accepted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  declined: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  expired: "bg-gray-500/15 text-gray-600 dark:text-gray-400",
  superseded: "bg-gray-500/15 text-gray-600 dark:text-gray-400",
  converted: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
};

/** "12.50" -> 1250 cents; NaN-safe (returns 0). */
export function parseMoneyInput(value: string): number {
  const n = Number(value.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/** 1250 -> "12.50"; empty string for null. */
export function centsToInput(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

/** Decimal quantity input, two decimals max. */
export function parseQuantity(value: string): number {
  const n = Number(value.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}
