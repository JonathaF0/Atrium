import { describe, expect, it } from "bun:test";
import { DEFAULT_SLA_TARGETS, type SlaTargets } from "@atrium/shared";
import { ALWAYS_OPEN } from "../service-core";
import type { BusinessCalendar } from "../service-core";
import { clockStopped, computeDueDates, isValidTargets, parseTargets, slaOnStatusChange, toCalendar, warnAt } from "./sla";

// Mon-Fri 09:00-17:00 UTC.
const WEEKDAYS: BusinessCalendar = {
  timezone: "UTC",
  schedule: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })),
  holidays: [],
};

const TARGETS: SlaTargets = {
  urgent: { firstResponseMins: 60, resolutionMins: 480 },
  high: { firstResponseMins: 240, resolutionMins: 960 },
  normal: { firstResponseMins: 480, resolutionMins: 2400 },
  low: { firstResponseMins: 960, resolutionMins: 4800 },
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

describe("computeDueDates", () => {
  it("adds wall-clock minutes on an always-open calendar", () => {
    const due = computeDueDates(new Date("2026-03-02T10:00:00Z"), "urgent", TARGETS, 0, ALWAYS_OPEN);
    expect(iso(due.firstResponseDueAt)).toBe("2026-03-02T11:00:00.000Z");
    expect(iso(due.resolutionDueAt)).toBe("2026-03-02T18:00:00.000Z");
  });

  it("only counts business hours", () => {
    // Monday 16:30 + 60 business minutes = Tuesday 09:30.
    const due = computeDueDates(new Date("2026-03-02T16:30:00Z"), "urgent", TARGETS, 0, WEEKDAYS);
    expect(iso(due.firstResponseDueAt)).toBe("2026-03-03T09:30:00.000Z");
    // 480 business minutes = one full day: Tuesday 16:30.
    expect(iso(due.resolutionDueAt)).toBe("2026-03-03T16:30:00.000Z");
  });

  it("skips weekends", () => {
    // Friday 16:00 + 240 minutes = Monday 12:00.
    const due = computeDueDates(new Date("2026-03-06T16:00:00Z"), "high", TARGETS, 0, WEEKDAYS);
    expect(iso(due.firstResponseDueAt)).toBe("2026-03-09T12:00:00.000Z");
  });

  it("starts the clock at opening time for tickets created out of hours", () => {
    const due = computeDueDates(new Date("2026-03-07T12:00:00Z"), "urgent", TARGETS, 0, WEEKDAYS); // Saturday
    expect(iso(due.firstResponseDueAt)).toBe("2026-03-09T10:00:00.000Z");
  });

  it("skips holidays", () => {
    const cal: BusinessCalendar = { ...WEEKDAYS, holidays: ["2026-03-03"] };
    const due = computeDueDates(new Date("2026-03-02T16:30:00Z"), "urgent", TARGETS, 0, cal);
    expect(iso(due.firstResponseDueAt)).toBe("2026-03-04T09:30:00.000Z");
  });

  it("respects the calendar's time zone", () => {
    const cal: BusinessCalendar = { ...WEEKDAYS, timezone: "America/New_York" };
    // Monday 08:00 New York (13:00 UTC, EST) is before opening: due 10:00 New York = 15:00 UTC.
    const due = computeDueDates(new Date("2026-03-02T13:00:00Z"), "urgent", TARGETS, 0, cal);
    expect(iso(due.firstResponseDueAt)).toBe("2026-03-02T15:00:00.000Z");
  });

  it("pushes due dates out by paused business time", () => {
    const due = computeDueDates(new Date("2026-03-02T09:00:00Z"), "urgent", TARGETS, 30 * 60, WEEKDAYS);
    expect(iso(due.firstResponseDueAt)).toBe("2026-03-02T10:30:00.000Z");
  });

  it("falls back to normal targets for an unknown priority", () => {
    const due = computeDueDates(new Date("2026-03-02T09:00:00Z"), "bogus", TARGETS, 0, ALWAYS_OPEN);
    expect(iso(due.firstResponseDueAt)).toBe("2026-03-02T17:00:00.000Z");
  });
});

describe("warnAt", () => {
  it("is the instant the given share of the target is used", () => {
    // 80% of 60 business minutes from 09:00 = 09:48.
    expect(iso(warnAt(new Date("2026-03-02T09:00:00Z"), 60, 80, 0, WEEKDAYS))).toBe("2026-03-02T09:48:00.000Z");
  });

  it("includes paused time", () => {
    expect(iso(warnAt(new Date("2026-03-02T09:00:00Z"), 60, 50, 600, WEEKDAYS))).toBe("2026-03-02T09:40:00.000Z");
  });
});

describe("clockStopped", () => {
  it("stops for waiting, on-hold and finished statuses", () => {
    for (const s of ["waiting_client", "waiting_third_party", "on_hold", "resolved", "closed"]) expect(clockStopped(s)).toBe(true);
    for (const s of ["new", "open"]) expect(clockStopped(s)).toBe(false);
  });
});

describe("slaOnStatusChange", () => {
  const base = {
    createdAt: new Date("2026-03-02T09:00:00Z"),
    priority: "urgent",
    status: "open",
    slaPausedAt: null as Date | null,
    slaPausedSeconds: 0,
  };

  it("records when the clock stops", () => {
    const now = new Date("2026-03-02T09:20:00Z");
    expect(slaOnStatusChange(base, "waiting_client", now, TARGETS, WEEKDAYS)).toEqual({ slaPausedAt: now });
  });

  it("adds paused business time and recomputes due dates on resume", () => {
    const paused = { ...base, status: "waiting_client", slaPausedAt: new Date("2026-03-02T09:20:00Z") };
    const now = new Date("2026-03-02T10:20:00Z");
    const out = slaOnStatusChange(paused, "open", now, TARGETS, WEEKDAYS);
    expect(out.slaPausedAt).toBeNull();
    expect(out.slaPausedSeconds).toBe(3600);
    expect(iso(out.firstResponseDueAt ?? null)).toBe("2026-03-02T11:00:00.000Z");
    expect(out.slaWarnedAt).toBeNull();
  });

  it("counts only business time while paused (overnight wait)", () => {
    const paused = { ...base, status: "on_hold", slaPausedAt: new Date("2026-03-02T16:00:00Z") };
    const out = slaOnStatusChange(paused, "open", new Date("2026-03-03T10:00:00Z"), TARGETS, WEEKDAYS);
    expect(out.slaPausedSeconds).toBe(2 * 3600);
  });

  it("accumulates over several pauses", () => {
    const paused = { ...base, status: "on_hold", slaPausedSeconds: 600, slaPausedAt: new Date("2026-03-02T11:00:00Z") };
    const out = slaOnStatusChange(paused, "open", new Date("2026-03-02T11:10:00Z"), TARGETS, WEEKDAYS);
    expect(out.slaPausedSeconds).toBe(1200);
  });

  it("does nothing between two running or two stopped statuses", () => {
    expect(slaOnStatusChange(base, "new", new Date(), TARGETS, WEEKDAYS)).toEqual({});
    const paused = { ...base, status: "on_hold", slaPausedAt: new Date() };
    expect(slaOnStatusChange(paused, "resolved", new Date(), TARGETS, WEEKDAYS)).toEqual({});
  });

  it("treats reopening a resolved ticket as a resume", () => {
    const resolved = { ...base, status: "resolved", slaPausedAt: new Date("2026-03-02T10:00:00Z") };
    const out = slaOnStatusChange(resolved, "open", new Date("2026-03-02T12:00:00Z"), TARGETS, WEEKDAYS);
    expect(out.slaPausedSeconds).toBe(7200);
    expect(iso(out.resolutionDueAt ?? null)).toBe("2026-03-03T11:00:00.000Z");
  });

  it("without a policy only tracks the pause", () => {
    const paused = { ...base, status: "on_hold", slaPausedAt: new Date("2026-03-02T09:00:00Z") };
    const out = slaOnStatusChange(paused, "open", new Date("2026-03-02T09:30:00Z"), null, WEEKDAYS);
    expect(out).toEqual({ slaPausedAt: null, slaPausedSeconds: 1800 });
  });
});

describe("targets and calendars", () => {
  it("parseTargets keeps valid entries and defaults the rest", () => {
    const parsed = parseTargets({ urgent: { firstResponseMins: 15, resolutionMins: 120 }, low: { firstResponseMins: -1, resolutionMins: 5 } });
    expect(parsed.urgent).toEqual({ firstResponseMins: 15, resolutionMins: 120 });
    expect(parsed.low).toEqual(DEFAULT_SLA_TARGETS.low);
  });

  it("isValidTargets requires every priority", () => {
    expect(isValidTargets(TARGETS)).toBe(true);
    expect(isValidTargets({ urgent: TARGETS.urgent })).toBe(false);
    expect(isValidTargets({ ...TARGETS, low: { firstResponseMins: 0, resolutionMins: 10 } })).toBe(false);
  });

  it("toCalendar falls back to always-open for an empty or invalid schedule", () => {
    expect(toCalendar(null)).toBe(ALWAYS_OPEN);
    expect(toCalendar({ timezone: "UTC", schedule: [], holidays: [] })).toBe(ALWAYS_OPEN);
    expect(toCalendar({ timezone: "UTC", schedule: [{ day: 9 }], holidays: [] })).toBe(ALWAYS_OPEN);
    const cal = toCalendar({ timezone: "UTC", schedule: WEEKDAYS.schedule, holidays: [{ date: new Date("2026-12-25T00:00:00Z") }] });
    expect(cal.holidays).toEqual(["2026-12-25"]);
  });
});
