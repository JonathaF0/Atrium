import type { RecurringInterval } from "@atrium/shared";

/**
 * Billing-schedule date math. Everything works in UTC calendar days.
 *
 * Periods are billed in advance: the run at `nextRunAt` covers
 * [nextRunAt, next boundary). Without proration, boundaries repeat on the start
 * date's day of the month; a start on the 31st falls back to the last day of
 * shorter months (Jan 31 -> Feb 28 -> Mar 31), because every date is derived
 * from the anchor day rather than from the previous (already clamped) date.
 *
 * Proration rule (prorateFirst): boundaries snap to calendar periods - the
 * Monday of a week, the 1st of a month, the 1st of Jan/Apr/Jul/Oct, Jan 1. A
 * start date inside a period gets a first invoice covering start -> next
 * boundary, with each line's unit price scaled by
 * (days in the partial period / days in a full period ending at that boundary).
 * Every later run bills a full period from a boundary. A start exactly on a
 * boundary is not prorated.
 */

const DAY_MS = 86_400_000;

export interface ScheduleTiming {
  interval: RecurringInterval | string;
  intervalCount: number;
  startDate: Date;
  prorateFirst: boolean;
}

export interface BillingPeriod {
  start: Date;
  end: Date; // exclusive
  /** Fraction of a full period this run bills, 1 for a full period. */
  factor: number;
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfUtcDay(b).getTime() - startOfUtcDay(a).getTime()) / DAY_MS);
}

/** Adds whole months, landing on `anchorDay` or the month's last day when it is shorter. */
export function addMonthsClamped(date: Date, months: number, anchorDay: number): Date {
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(anchorDay, daysInMonth(year, month));
  return new Date(Date.UTC(year, month, day));
}

function monthsPerUnit(interval: string): number {
  if (interval === "quarterly") return 3;
  if (interval === "yearly") return 12;
  return 1;
}

/** One step (`count` units) forward or backward from `date`. */
export function addInterval(date: Date, interval: string, count: number, anchorDay: number): Date {
  if (interval === "weekly") return new Date(startOfUtcDay(date).getTime() + 7 * count * DAY_MS);
  return addMonthsClamped(date, monthsPerUnit(interval) * count, anchorDay);
}

/** True when `date` starts a calendar period of this interval. */
export function isCalendarBoundary(date: Date, interval: string): boolean {
  if (interval === "weekly") return date.getUTCDay() === 1;
  if (date.getUTCDate() !== 1) return false;
  const month = date.getUTCMonth();
  if (interval === "quarterly") return month % 3 === 0;
  if (interval === "yearly") return month === 0;
  return true;
}

/** The first calendar boundary strictly after `date`. */
export function nextCalendarBoundary(date: Date, interval: string): Date {
  const d = startOfUtcDay(date);
  if (interval === "weekly") {
    const offset = ((8 - d.getUTCDay()) % 7) || 7; // days to next Monday
    return new Date(d.getTime() + offset * DAY_MS);
  }
  const per = monthsPerUnit(interval);
  const monthIndex = d.getUTCFullYear() * 12 + d.getUTCMonth();
  const nextStart = (Math.floor(monthIndex / per) + 1) * per;
  return new Date(Date.UTC(Math.floor(nextStart / 12), nextStart % 12, 1));
}

/** The day-of-month later boundaries land on. */
export function anchorDayOf(timing: ScheduleTiming): number {
  return timing.prorateFirst ? 1 : startOfUtcDay(timing.startDate).getUTCDate();
}

function needsProration(timing: ScheduleTiming): boolean {
  return timing.prorateFirst && !isCalendarBoundary(startOfUtcDay(timing.startDate), timing.interval);
}

/**
 * The period billed by the run at `runAt`. `isFirstRun` is true when no invoice
 * has been generated for the schedule yet.
 */
export function periodFor(timing: ScheduleTiming, runAt: Date, isFirstRun: boolean): BillingPeriod {
  const start = startOfUtcDay(runAt);
  const count = Math.max(1, timing.intervalCount);
  if (isFirstRun && needsProration(timing)) {
    const end = nextCalendarBoundary(start, timing.interval);
    const fullStart = addInterval(end, timing.interval, -count, 1);
    const full = daysBetween(fullStart, end);
    const partial = daysBetween(start, end);
    return { start, end, factor: full > 0 ? Math.min(1, partial / full) : 1 };
  }
  return { start, end: addInterval(start, timing.interval, count, anchorDayOf(timing)), factor: 1 };
}

/** Scales a unit price for a partial period, rounding to the nearest cent. */
export function prorate(unitPrice: number, factor: number): number {
  return factor >= 1 ? unitPrice : Math.round(unitPrice * factor);
}

/** Run dates from `nextRunAt` on, stopping after `endDate` (inclusive) or `limit` runs. */
export function upcomingRuns(
  timing: ScheduleTiming & { endDate: Date | null },
  nextRunAt: Date,
  isFirstRun: boolean,
  limit: number,
): BillingPeriod[] {
  const runs: BillingPeriod[] = [];
  let at = startOfUtcDay(nextRunAt);
  let first = isFirstRun;
  while (runs.length < limit) {
    if (timing.endDate && at.getTime() > timing.endDate.getTime()) break;
    const period = periodFor(timing, at, first);
    runs.push(period);
    at = period.end;
    first = false;
  }
  return runs;
}

/**
 * After a pause, periods that passed are skipped rather than billed in a burst:
 * returns the first run date on or after `now`'s day.
 */
export function skipMissedRuns(timing: ScheduleTiming, nextRunAt: Date, isFirstRun: boolean, now: Date): Date {
  const today = startOfUtcDay(now);
  let at = startOfUtcDay(nextRunAt);
  let first = isFirstRun;
  for (let i = 0; i < 2000 && at.getTime() < today.getTime(); i++) {
    at = periodFor(timing, at, first).end;
    first = false;
  }
  return at;
}

export function formatPeriod(period: BillingPeriod): string {
  const fmt = (d: Date): string =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const lastDay = new Date(period.end.getTime() - DAY_MS);
  return `${fmt(period.start)} - ${fmt(lastDay)}`;
}

// ── Dunning ──

export const DEFAULT_DUNNING_DAYS = [3, 7, 14];

/**
 * Parses DUNNING_DAYS ("3,7,14"). Empty, "off" or "0" disables reminders.
 * Invalid entries are dropped; the result is sorted and de-duplicated.
 */
export function parseDunningDays(raw: string | undefined): number[] {
  if (raw === undefined) return DEFAULT_DUNNING_DAYS;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "off" || trimmed === "0") return [];
  const days = trimmed
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 365);
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * The dunning stage an invoice should be at: how many offsets it has passed.
 * Returns null when no new reminder is due. An invoice that skipped stages
 * (e.g. reminders were just switched on) jumps to the latest one and gets a
 * single reminder.
 */
export function dueDunningStage(dueDate: Date, now: Date, stages: number[], currentStage: number): number | null {
  const overdueDays = Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS);
  if (overdueDays <= 0) return null;
  const reached = stages.filter((d) => overdueDays >= d).length;
  return reached > currentStage ? reached : null;
}

export function overdueDays(dueDate: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS));
}
