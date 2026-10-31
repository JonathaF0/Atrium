export interface ScheduleItem {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateBps: number;
}

export interface Schedule {
  id: string;
  name: string;
  companyId: string | null;
  recipientUserId: string | null;
  projectId: string | null;
  interval: string;
  intervalCount: number;
  startDate: string;
  endDate: string | null;
  nextRunAt: string;
  lastRunAt: string | null;
  dueDays: number;
  prorateFirst: boolean;
  autoSend: boolean;
  autoCharge: boolean;
  status: string;
  notes: string | null;
  hasCard: boolean;
  company?: { id: string; name: string } | null;
  items: ScheduleItem[];
  totals: { subtotalCents: number; taxCents: number; totalCents: number };
  upcoming: Array<{ runAt: string; periodEnd: string; factor: number }>;
}

export interface ScheduleDetail extends Schedule {
  recipient: { id: string; name: string; email: string } | null;
  project: { id: string; name: string } | null;
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    dueDate: string | null;
    createdAt: string;
    projectId: string | null;
    lineItems: Array<{ quantity: number; unitPrice: number; taxRateBps?: number }>;
  }>;
}

export interface ScheduleOptions {
  companies: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  clients: Array<{ userId: string; name: string; email: string; companyId: string | null }>;
}

export const INTERVAL_OPTIONS = [
  { value: "weekly", label: "Week(s)" },
  { value: "monthly", label: "Month(s)" },
  { value: "quarterly", label: "Quarter(s)" },
  { value: "yearly", label: "Year(s)" },
];

const UNIT: Record<string, [string, string]> = {
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  quarterly: ["quarter", "quarters"],
  yearly: ["year", "years"],
};

export function intervalLabel(interval: string, count: number): string {
  const [one, many] = UNIT[interval] ?? [interval, interval];
  return count === 1 ? `Every ${one}` : `Every ${count} ${many}`;
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  active: { bg: "#dcfce7", text: "#15803d" },
  paused: { bg: "#fef3c7", text: "#b45309" },
  ended: { bg: "#e5e7eb", text: "#374151" },
};
