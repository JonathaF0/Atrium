import { Prisma } from "@atrium/database";
import { lineTaxCents } from "@atrium/shared";

// ─── Percentiles ───

/**
 * Continuous percentile with linear interpolation; the same definition as
 * Postgres `percentile_cont`, which the reports use in SQL. `p` in [0, 1].
 */
export function percentileCont(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Share as a percentage with one decimal, or null when there is nothing to measure. */
export function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

// ─── Invoice totals ───

export interface InvoiceLike {
  type: string;
  amount: number | null;
  lineItems: { quantity: number; unitPrice: number; taxRateBps: number }[];
}

/**
 * Invoice total in cents: uploaded invoices carry `amount`; itemized ones are
 * Σ quantity × unitPrice plus Σ per-line tax. `invoiceTotalSql` is the same rule in SQL.
 */
export function invoiceTotalCents(inv: InvoiceLike): number {
  if (inv.type === "uploaded") return inv.amount ?? 0;
  let subtotal = 0;
  let tax = 0;
  for (const li of inv.lineItems) {
    subtotal += li.quantity * li.unitPrice;
    tax += lineTaxCents(li.quantity, li.unitPrice, li.taxRateBps);
  }
  return subtotal + tax;
}

/** SQL for the total (bigint cents) of the invoice aliased `alias`. */
export function invoiceTotalSql(alias: string): Prisma.Sql {
  const i = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(CASE WHEN ${i}.type = 'uploaded' THEN COALESCE(${i}.amount, 0)::bigint ELSE COALESCE((
    SELECT SUM(li.quantity::bigint * li."unitPrice")
      + SUM(CASE WHEN li."taxRateBps" > 0
          THEN ROUND(li.quantity::numeric * li."unitPrice" * li."taxRateBps" / 10000) ELSE 0 END)
    FROM "invoice_line_item" li WHERE li."invoiceId" = ${i}.id
  ), 0)::bigint END)`;
}

// ─── AR aging ───

export const AGING_BUCKETS = [
  { key: "current", label: "Current", maxDays: 0 },
  { key: "d1_30", label: "1-30 days", maxDays: 30 },
  { key: "d31_60", label: "31-60 days", maxDays: 60 },
  { key: "d61_90", label: "61-90 days", maxDays: 90 },
  { key: "d90_plus", label: "90+ days", maxDays: null },
] as const;

export type AgingKey = (typeof AGING_BUCKETS)[number]["key"];

/** Aging bucket for an invoice `daysPastDue` days past its due date (≤ 0 or no due date: current). */
export function agingBucket(daysPastDue: number | null): AgingKey {
  if (daysPastDue === null) return "current";
  for (const b of AGING_BUCKETS) {
    if (b.maxDays === null || daysPastDue <= b.maxDays) return b.key;
  }
  return "d90_plus";
}

/** `agingBucket` as a SQL CASE over an integer days-past-due expression (NULL is current). */
export function agingBucketSql(days: Prisma.Sql): Prisma.Sql {
  const whens = AGING_BUCKETS.filter((b) => b.maxDays !== null).map(
    (b) => Prisma.sql`WHEN ${days} <= ${Prisma.raw(String(b.maxDays))} THEN ${Prisma.raw(`'${b.key}'`)}`,
  );
  return Prisma.sql`(CASE WHEN ${days} IS NULL THEN 'current' ${Prisma.join(whens, " ")} ELSE 'd90_plus' END)`;
}

// ─── Recurring revenue ───

/**
 * Factor turning one run of a schedule into a monthly amount: weekly runs
 * happen 52/12 times a month, quarterly a third of a month, and so on, divided
 * by the interval count ("every 2 months" is half). Unknown intervals count 0.
 */
export function monthlyFactor(interval: string, intervalCount: number): number {
  const n = Math.max(1, Math.floor(intervalCount || 1));
  const perMonth: Record<string, number> = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
  return (perMonth[interval] ?? 0) / n;
}

export function monthlyRecurringCents(runCents: number, interval: string, intervalCount: number): number {
  return Math.round(runCents * monthlyFactor(interval, intervalCount));
}

// ─── Contract allowance ───

const DAY_MS = 86_400_000;
const PERIOD_DAYS: Record<string, number> = {
  monthly: 365.25 / 12,
  quarterly: 365.25 / 4,
  yearly: 365.25,
};

export interface ContractLike {
  startsAt: Date;
  endsAt: Date | null;
  coveredMinutes: number | null;
  coveragePeriod: string;
}

/**
 * Covered minutes a contract allows inside [start, end). The allowance accrues
 * evenly over time: `coveredMinutes` per average-length period (a month is
 * 365.25 / 12 days), prorated by the part of the range the contract runs in.
 * A "term" allowance covers the whole contract and is prorated over its term;
 * an open-ended term contract counts in full once it has started.
 */
export function contractAllowanceMinutes(c: ContractLike, start: Date, end: Date): number {
  if (!c.coveredMinutes || c.coveredMinutes <= 0) return 0;
  const from = Math.max(start.getTime(), c.startsAt.getTime());
  const to = Math.min(end.getTime(), c.endsAt ? c.endsAt.getTime() : Number.POSITIVE_INFINITY);
  if (to <= from) return 0;
  const overlap = to - from;
  if (c.coveragePeriod === "term") {
    if (!c.endsAt) return c.coveredMinutes;
    const term = c.endsAt.getTime() - c.startsAt.getTime();
    return term > 0 ? Math.round((c.coveredMinutes * overlap) / term) : c.coveredMinutes;
  }
  const periodDays = PERIOD_DAYS[c.coveragePeriod] ?? PERIOD_DAYS.monthly;
  return Math.round((c.coveredMinutes * overlap) / (periodDays * DAY_MS));
}
