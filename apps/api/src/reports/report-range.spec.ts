import { describe, it, expect } from "bun:test";
import {
  addDays,
  buildBuckets,
  chooseBucket,
  localDateKey,
  resolveRange,
  truncateDate,
  tzOffsetMs,
  zonedDayStart,
} from "./report-range";

describe("zonedDayStart", () => {
  it("is midnight UTC for UTC", () => {
    expect(zonedDayStart("2026-03-01", "UTC").toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("shifts by the zone's offset", () => {
    expect(zonedDayStart("2026-01-15", "America/New_York").toISOString()).toBe("2026-01-15T05:00:00.000Z");
    expect(zonedDayStart("2026-07-15", "America/New_York").toISOString()).toBe("2026-07-15T04:00:00.000Z");
    expect(zonedDayStart("2026-01-15", "Asia/Tokyo").toISOString()).toBe("2026-01-14T15:00:00.000Z");
  });

  it("handles the day daylight saving starts", () => {
    // Clocks go forward at 02:00 on 2026-03-08 in New York; midnight is still EST.
    expect(zonedDayStart("2026-03-08", "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedDayStart("2026-03-09", "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("round-trips with localDateKey", () => {
    for (const tz of ["UTC", "Australia/Sydney", "America/Los_Angeles", "Asia/Kolkata"]) {
      const start = zonedDayStart("2026-10-04", tz);
      expect(localDateKey(start, tz)).toBe("2026-10-04");
      expect(localDateKey(new Date(start.getTime() - 1000), tz)).toBe("2026-10-03");
    }
  });

  it("offset is positive east of UTC", () => {
    expect(tzOffsetMs(new Date("2026-01-01T00:00:00Z"), "Asia/Tokyo")).toBe(9 * 3600_000);
  });
});

describe("resolveRange", () => {
  const now = new Date("2026-10-31T02:00:00Z");

  it("defaults to the last 30 days ending today in the zone", () => {
    const r = resolveRange({}, "UTC", now);
    expect(r.to).toBe("2026-10-31");
    expect(r.from).toBe("2026-10-02");
    expect(r.days).toBe(30);
    expect(r.start.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("uses the workspace's local date for today", () => {
    // 02:00 UTC on the 31st is still the 30th in Los Angeles.
    expect(resolveRange({}, "America/Los_Angeles", now).to).toBe("2026-10-30");
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(resolveRange({}, "Not/AZone", now).timezone).toBe("UTC");
  });

  it("rejects bad input", () => {
    expect(() => resolveRange({ from: "2026-02-30" }, "UTC", now)).toThrow();
    expect(() => resolveRange({ from: "2026-05-02", to: "2026-05-01" }, "UTC", now)).toThrow();
    expect(() => resolveRange({ from: "2010-01-01", to: "2026-01-01" }, "UTC", now)).toThrow();
  });

  it("accepts an explicit range", () => {
    const r = resolveRange({ from: "2026-01-01", to: "2026-01-31" }, "Europe/Berlin", now);
    expect(r.days).toBe(31);
    expect(r.start.toISOString()).toBe("2025-12-31T23:00:00.000Z");
  });
});

describe("bucketing", () => {
  it("chooses buckets by range length", () => {
    expect(chooseBucket(1)).toBe("day");
    expect(chooseBucket(62)).toBe("day");
    expect(chooseBucket(63)).toBe("week");
    expect(chooseBucket(366)).toBe("week");
    expect(chooseBucket(367)).toBe("month");
  });

  it("truncates weeks to Monday and months to the 1st", () => {
    expect(truncateDate("2026-10-31", "week")).toBe("2026-10-26"); // Saturday → Monday
    expect(truncateDate("2026-10-26", "week")).toBe("2026-10-26");
    expect(truncateDate("2026-11-01", "week")).toBe("2026-10-26"); // Sunday
    expect(truncateDate("2026-10-31", "month")).toBe("2026-10-01");
    expect(truncateDate("2026-10-31", "day")).toBe("2026-10-31");
  });

  it("builds every day bucket inclusive", () => {
    const b = buildBuckets("2026-10-30", "2026-11-02", "day");
    expect(b.map((x) => x.key)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(b[3].endKey).toBe("2026-11-03");
  });

  it("builds week buckets covering the range", () => {
    const b = buildBuckets("2026-10-01", "2026-10-20", "week");
    expect(b.map((x) => x.key)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"]);
  });

  it("builds month buckets across a year end", () => {
    const b = buildBuckets("2025-11-15", "2026-02-03", "month");
    expect(b.map((x) => x.key)).toEqual(["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"]);
    expect(b[1].endKey).toBe("2026-01-01");
  });

  it("adds days across months", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
