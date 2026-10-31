import { describe, expect, it } from "bun:test";
import { ALWAYS_OPEN, addBusinessMinutes, businessMinutesBetween, isValidSchedule } from "./business-hours";
import type { BusinessCalendar } from "./business-hours";

const weekdays9to5 = (timezone: string, holidays: string[] = []): BusinessCalendar => ({
  timezone,
  schedule: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })),
  holidays,
});

describe("addBusinessMinutes", () => {
  it("adds wall-clock time on an always-open calendar", () => {
    const from = new Date("2026-03-02T10:00:00Z");
    expect(addBusinessMinutes(from, 90, ALWAYS_OPEN)?.toISOString()).toBe("2026-03-02T11:30:00.000Z");
  });

  it("stays inside the same day when there is time left", () => {
    // Monday 10:00 UTC
    const due = addBusinessMinutes(new Date("2026-03-02T10:00:00Z"), 120, weekdays9to5("UTC"));
    expect(due?.toISOString()).toBe("2026-03-02T12:00:00.000Z");
  });

  it("rolls over the evening and the weekend", () => {
    // Friday 16:00 UTC + 2h → Monday 10:00
    const due = addBusinessMinutes(new Date("2026-03-06T16:00:00Z"), 120, weekdays9to5("UTC"));
    expect(due?.toISOString()).toBe("2026-03-09T10:00:00.000Z");
  });

  it("starts the clock at opening time when created outside hours", () => {
    // Saturday → Monday 09:00 + 30m
    const due = addBusinessMinutes(new Date("2026-03-07T12:00:00Z"), 30, weekdays9to5("UTC"));
    expect(due?.toISOString()).toBe("2026-03-09T09:30:00.000Z");
  });

  it("skips holidays", () => {
    const due = addBusinessMinutes(new Date("2026-03-06T16:00:00Z"), 120, weekdays9to5("UTC", ["2026-03-09"]));
    expect(due?.toISOString()).toBe("2026-03-10T10:00:00.000Z");
  });

  it("uses the calendar's time zone, across a DST change", () => {
    // New York: 9-5 local. 2026-03-09 (after DST start on 03-08) is UTC-4, so 09:00 local = 13:00Z.
    const due = addBusinessMinutes(new Date("2026-03-06T21:30:00Z"), 60, weekdays9to5("America/New_York"));
    // Friday 16:30 local (UTC-5) leaves 30 min; the rest starts Monday 09:00 local (13:00Z).
    expect(due?.toISOString()).toBe("2026-03-09T13:30:00.000Z");
  });

  it("returns null for a calendar with no open time", () => {
    expect(addBusinessMinutes(new Date(), 10, { timezone: "UTC", schedule: [], holidays: [] })).toBeNull();
  });
});

describe("businessMinutesBetween", () => {
  it("counts only open time", () => {
    const cal = weekdays9to5("UTC");
    // Friday 16:00 → Monday 10:00 = 60 + 60
    expect(businessMinutesBetween(new Date("2026-03-06T16:00:00Z"), new Date("2026-03-09T10:00:00Z"), cal)).toBe(120);
  });

  it("is zero when the end is not after the start", () => {
    const at = new Date("2026-03-02T10:00:00Z");
    expect(businessMinutesBetween(at, at, ALWAYS_OPEN)).toBe(0);
  });
});

describe("isValidSchedule", () => {
  it("accepts well-formed windows, including a 24:00 end", () => {
    expect(isValidSchedule([{ day: 1, start: "09:00", end: "17:00" }, { day: 0, start: "00:00", end: "24:00" }])).toBe(true);
  });

  it("rejects bad days, times and reversed windows", () => {
    expect(isValidSchedule([{ day: 7, start: "09:00", end: "17:00" }])).toBe(false);
    expect(isValidSchedule([{ day: 1, start: "9:00", end: "17:00" }])).toBe(false);
    expect(isValidSchedule([{ day: 1, start: "17:00", end: "09:00" }])).toBe(false);
    expect(isValidSchedule("nope")).toBe(false);
  });
});
