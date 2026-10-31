import { isValidTimeZone } from "../common/helpers/local-time";

export interface BusinessWindow {
  day: number; // 0 = Sunday
  start: string; // "HH:MM"
  end: string; // "HH:MM", after start
}

export interface BusinessCalendar {
  timezone: string;
  schedule: BusinessWindow[];
  holidays: string[]; // "YYYY-MM-DD" in the calendar's zone
}

/** Every day, all day: the calendar used when an SLA policy has no business hours. */
export const ALWAYS_OPEN: BusinessCalendar = {
  timezone: "UTC",
  schedule: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "00:00", end: "24:00" })),
  holidays: [],
};

const MINUTE_MS = 60_000;
const MAX_DAYS_SCANNED = 400;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isValidSchedule(schedule: unknown): schedule is BusinessWindow[] {
  if (!Array.isArray(schedule)) return false;
  return schedule.every((w: unknown) => {
    if (!w || typeof w !== "object") return false;
    const { day, start, end } = w as Record<string, unknown>;
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) return false;
    if (typeof start !== "string" || typeof end !== "string") return false;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(end)) return false;
    return toMinutes(end) > toMinutes(start);
  });
}

/** Offset of `zone` from UTC at `instant`, in minutes (positive east of Greenwich). */
function zoneOffsetMinutes(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUtc: number = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - Math.floor(instant / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

/** UTC instant of a wall-clock time in `zone`. */
function zonedTimeToUtc(y: number, m: number, d: number, minutes: number, zone: string): number {
  const guess: number = Date.UTC(y, m, d) + minutes * MINUTE_MS;
  const first: number = guess - zoneOffsetMinutes(guess, zone) * MINUTE_MS;
  return guess - zoneOffsetMinutes(first, zone) * MINUTE_MS;
}

function localDate(instant: number, zone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month") - 1, d: get("day") };
}

/** Open intervals [start, end) in UTC ms, in order, starting with the local day containing `from`. */
function* openIntervals(from: number, cal: BusinessCalendar): Generator<[number, number]> {
  const zone: string = isValidTimeZone(cal.timezone) ? cal.timezone : "UTC";
  const holidays = new Set(cal.holidays);
  const start = localDate(from, zone);
  for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
    const day = new Date(Date.UTC(start.y, start.m, start.d + i));
    const y: number = day.getUTCFullYear();
    const m: number = day.getUTCMonth();
    const d: number = day.getUTCDate();
    const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (holidays.has(iso)) continue;
    const windows: BusinessWindow[] = cal.schedule
      .filter((w) => w.day === day.getUTCDay())
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    for (const w of windows) {
      const s: number = zonedTimeToUtc(y, m, d, toMinutes(w.start), zone);
      const e: number = zonedTimeToUtc(y, m, d, toMinutes(w.end), zone);
      if (e > from) yield [Math.max(s, from), e];
    }
  }
}

/** The instant `minutes` of business time after `from`. Null if the calendar has no open time. */
export function addBusinessMinutes(from: Date, minutes: number, cal: BusinessCalendar): Date | null {
  let remaining: number = minutes * MINUTE_MS;
  if (remaining <= 0) return from;
  for (const [s, e] of openIntervals(from.getTime(), cal)) {
    const span: number = e - s;
    if (remaining <= span) return new Date(s + remaining);
    remaining -= span;
  }
  return null;
}

/** Business minutes between two instants (0 when `to` is not after `from`). */
export function businessMinutesBetween(from: Date, to: Date, cal: BusinessCalendar): number {
  const end: number = to.getTime();
  if (end <= from.getTime()) return 0;
  let total = 0;
  for (const [s, e] of openIntervals(from.getTime(), cal)) {
    if (s >= end) break;
    total += Math.min(e, end) - s;
  }
  return Math.floor(total / MINUTE_MS);
}
