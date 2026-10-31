/**
 * Date ranges and buckets for reports. Dates are calendar days (YYYY-MM-DD) in
 * the workspace's timezone; queries get UTC instants for their bounds.
 */

export type BucketUnit = "day" | "week" | "month";

export interface Bucket {
  /** First local day of the bucket, YYYY-MM-DD (also the key SQL bucketing yields). */
  key: string;
  /** First local day after the bucket, YYYY-MM-DD. */
  endKey: string;
}

export interface ReportRange {
  from: string;
  to: string;
  timezone: string;
  /** Start of `from` in the workspace's timezone. */
  start: Date;
  /** Start of the day after `to` (exclusive end). */
  end: Date;
  days: number;
}

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 3 * 366 + 1;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidDateKey(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parts(instant: Date, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `tz` from UTC at `instant`, in milliseconds (positive east of UTC). */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which local day `date` (YYYY-MM-DD) starts in `tz`. */
export function zonedDayStart(date: string, tz: string): Date {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const first = tzOffsetMs(new Date(guess), tz);
  let t = guess - first;
  const second = tzOffsetMs(new Date(t), tz);
  if (second !== first) t = guess - second;
  return new Date(t);
}

/** Local calendar day of `instant` in `tz`, YYYY-MM-DD. */
export function localDateKey(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Resolves the requested range. Default: the 30 days ending today (inclusive)
 * in the workspace's timezone. Throws a message string on bad input.
 */
export function resolveRange(
  q: { from?: string; to?: string },
  tz: string,
  now: Date,
): ReportRange {
  const timezone = isValidTimeZone(tz) ? tz : "UTC";
  if (q.from && !isValidDateKey(q.from)) throw new RangeError("from must be a date (YYYY-MM-DD)");
  if (q.to && !isValidDateKey(q.to)) throw new RangeError("to must be a date (YYYY-MM-DD)");
  const to = q.to ?? (q.from ? addDays(q.from, DEFAULT_RANGE_DAYS - 1) : localDateKey(now, timezone));
  const from = q.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) throw new RangeError("from must be on or before to");
  const days = daysBetween(from, to) + 1;
  if (days > MAX_RANGE_DAYS) throw new RangeError("The range can be at most three years");
  return {
    from,
    to,
    timezone,
    start: zonedDayStart(from, timezone),
    end: zonedDayStart(addDays(to, 1), timezone),
    days,
  };
}

/** Day buckets up to two months, weeks up to a year, months beyond. */
export function chooseBucket(days: number): BucketUnit {
  if (days <= 62) return "day";
  if (days <= 366) return "week";
  return "month";
}

/** First day of the bucket containing `date`. Weeks start on Monday (as Postgres date_trunc). */
export function truncateDate(date: string, unit: BucketUnit): string {
  if (unit === "day") return date;
  if (unit === "month") return `${date.slice(0, 7)}-01`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

function nextBucket(key: string, unit: BucketUnit): string {
  if (unit === "day") return addDays(key, 1);
  if (unit === "week") return addDays(key, 7);
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** Every bucket touching [from, to], in order. The first and last may extend past the range. */
export function buildBuckets(from: string, to: string, unit: BucketUnit): Bucket[] {
  const out: Bucket[] = [];
  let key = truncateDate(from, unit);
  while (key <= to) {
    const endKey = nextBucket(key, unit);
    out.push({ key, endKey });
    key = endKey;
  }
  return out;
}
