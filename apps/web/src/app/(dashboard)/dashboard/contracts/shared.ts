import { CONTRACT_TYPES, CONTRACT_TYPE_LABELS } from "@atrium/shared";
import type { ContractType } from "@atrium/shared";

export { CONTRACT_TYPES, CONTRACT_TYPE_LABELS };
export type { ContractType };

export const CONTRACT_STATUSES = ["draft", "active", "expired", "cancelled"] as const;
export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  expired: "Expired",
  cancelled: "Cancelled",
};

export const COVERAGE_PERIODS = ["monthly", "quarterly", "yearly", "term"] as const;
export const COVERAGE_PERIOD_LABELS: Record<string, string> = {
  monthly: "per month",
  quarterly: "per quarter",
  yearly: "per year",
  term: "for the whole term",
};

export interface ContractUsage {
  period: { start: string; end: string | null; coveragePeriod: string };
  coveredMinutes: number | null;
  usedMinutes: number;
  remainingMinutes: number | null;
  overageMinutes: number;
  overageCents: number | null;
}

export interface Contract {
  id: string;
  companyId: string;
  name: string;
  type: ContractType;
  status: string;
  startsAt: string;
  endsAt: string | null;
  autoRenew: boolean;
  renewalNoticeDays: number;
  coveredMinutes: number | null;
  coveragePeriod: string;
  overageRateCents: number | null;
  includedServices: string[];
  slaPolicyId: string | null;
  documentUrl: string | null;
  notes: string | null;
  company: { id: string; name: string };
  slaPolicy: { id: string; name: string } | null;
  usage: ContractUsage | null;
}

/** 90 -> "1h 30m", 120 -> "2h", 45 -> "45m". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The period's last day for display (the stored end is exclusive). */
export function periodLabel(period: { start: string; end: string | null }): string {
  if (!period.end) return `since ${formatDay(period.start)}`;
  const lastDay = new Date(new Date(period.end).getTime() - 1).toISOString();
  return `${formatDay(period.start)} – ${formatDay(lastDay)}`;
}

export function usagePercent(usage: ContractUsage): number {
  if (!usage.coveredMinutes) return usage.usedMinutes > 0 ? 100 : 0;
  return Math.min(100, Math.round((usage.usedMinutes / usage.coveredMinutes) * 100));
}
