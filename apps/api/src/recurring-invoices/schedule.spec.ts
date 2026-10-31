import { describe, expect, it } from "bun:test";
import {
  addMonthsClamped,
  dueDunningStage,
  nextCalendarBoundary,
  parseDunningDays,
  periodFor,
  prorate,
  skipMissedRuns,
  upcomingRuns,
} from "./schedule";

const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date): string => x.toISOString().slice(0, 10);

describe("addMonthsClamped", () => {
  it("keeps the anchor day through short months", () => {
    let at = d("2026-01-31");
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      at = addMonthsClamped(at, 1, 31);
      seen.push(iso(at));
    }
    expect(seen).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("handles leap years and year rollover", () => {
    expect(iso(addMonthsClamped(d("2027-12-29"), 2, 29))).toBe("2028-02-29");
    expect(iso(addMonthsClamped(d("2026-11-15"), 3, 15))).toBe("2027-02-15");
    expect(iso(addMonthsClamped(d("2026-03-31"), -1, 31))).toBe("2026-02-28");
  });
});

describe("periodFor", () => {
  const monthly = { interval: "monthly", intervalCount: 1, startDate: d("2026-01-31"), prorateFirst: false };

  it("bills a full month anchored on the start day", () => {
    const p = periodFor(monthly, d("2026-01-31"), true);
    expect(iso(p.end)).toBe("2026-02-28");
    expect(p.factor).toBe(1);
    const next = periodFor(monthly, p.end, false);
    expect(iso(next.end)).toBe("2026-03-31");
  });

  it("supports interval counts and quarterly/yearly/weekly steps", () => {
    const base = { intervalCount: 2, startDate: d("2026-01-10"), prorateFirst: false };
    expect(iso(periodFor({ ...base, interval: "monthly" }, d("2026-01-10"), true).end)).toBe("2026-03-10");
    expect(iso(periodFor({ ...base, interval: "quarterly" }, d("2026-01-10"), true).end)).toBe("2026-07-10");
    expect(iso(periodFor({ ...base, interval: "yearly" }, d("2026-01-10"), true).end)).toBe("2028-01-10");
    expect(iso(periodFor({ ...base, interval: "weekly" }, d("2026-01-10"), true).end)).toBe("2026-01-24");
  });

  it("prorates a mid-month start to the 1st of next month", () => {
    const timing = { interval: "monthly", intervalCount: 1, startDate: d("2026-03-15"), prorateFirst: true };
    const p = periodFor(timing, d("2026-03-15"), true);
    expect(iso(p.end)).toBe("2026-04-01");
    expect(p.factor).toBeCloseTo(17 / 31, 6);
    expect(prorate(10_000, p.factor)).toBe(5484);
    const second = periodFor(timing, p.end, false);
    expect(iso(second.end)).toBe("2026-05-01");
    expect(second.factor).toBe(1);
  });

  it("prorates quarterly and weekly starts to calendar boundaries", () => {
    const q = periodFor({ interval: "quarterly", intervalCount: 1, startDate: d("2026-02-01"), prorateFirst: true }, d("2026-02-01"), true);
    expect(iso(q.end)).toBe("2026-04-01");
    expect(q.factor).toBeCloseTo(59 / 90, 6);
    // 2026-10-29 is a Thursday: four days to Monday Nov 2.
    const w = periodFor({ interval: "weekly", intervalCount: 1, startDate: d("2026-10-29"), prorateFirst: true }, d("2026-10-29"), true);
    expect(iso(w.end)).toBe("2026-11-02");
    expect(w.factor).toBeCloseTo(4 / 7, 6);
  });

  it("does not prorate a start on a boundary", () => {
    const p = periodFor({ interval: "monthly", intervalCount: 1, startDate: d("2026-03-01"), prorateFirst: true }, d("2026-03-01"), true);
    expect(p.factor).toBe(1);
    expect(iso(p.end)).toBe("2026-04-01");
  });
});

describe("nextCalendarBoundary", () => {
  it("finds the next quarter and year start", () => {
    expect(iso(nextCalendarBoundary(d("2026-12-15"), "quarterly"))).toBe("2027-01-01");
    expect(iso(nextCalendarBoundary(d("2026-06-30"), "yearly"))).toBe("2027-01-01");
  });
});

describe("upcomingRuns", () => {
  it("stops at the end date", () => {
    const runs = upcomingRuns(
      { interval: "monthly", intervalCount: 1, startDate: d("2026-01-15"), prorateFirst: false, endDate: d("2026-03-15") },
      d("2026-01-15"),
      true,
      12,
    );
    expect(runs.map((r) => iso(r.start))).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });
});

describe("skipMissedRuns", () => {
  it("moves a resumed schedule to the first run on or after today", () => {
    const timing = { interval: "monthly", intervalCount: 1, startDate: d("2026-01-05"), prorateFirst: false };
    expect(iso(skipMissedRuns(timing, d("2026-02-05"), false, d("2026-05-20")))).toBe("2026-06-05");
    expect(iso(skipMissedRuns(timing, d("2026-06-05"), false, d("2026-05-20")))).toBe("2026-06-05");
  });
});

describe("dunning stages", () => {
  it("parses DUNNING_DAYS", () => {
    expect(parseDunningDays(undefined)).toEqual([3, 7, 14]);
    expect(parseDunningDays("14, 3,x,7,3")).toEqual([3, 7, 14]);
    expect(parseDunningDays("off")).toEqual([]);
    expect(parseDunningDays("")).toEqual([]);
  });

  it("advances one stage at a time and jumps when stages were skipped", () => {
    const due = d("2026-03-01");
    const stages = [3, 7, 14];
    expect(dueDunningStage(due, d("2026-03-03"), stages, 0)).toBeNull();
    expect(dueDunningStage(due, d("2026-03-04"), stages, 0)).toBe(1);
    expect(dueDunningStage(due, d("2026-03-05"), stages, 1)).toBeNull();
    expect(dueDunningStage(due, d("2026-03-08"), stages, 1)).toBe(2);
    expect(dueDunningStage(due, d("2026-03-20"), stages, 0)).toBe(3);
    expect(dueDunningStage(due, d("2026-04-20"), stages, 3)).toBeNull();
  });
});
