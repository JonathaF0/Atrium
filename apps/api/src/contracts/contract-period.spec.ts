import { describe, expect, it } from "bun:test";
import {
  addMonths,
  computeUsage,
  needsRenewalNotice,
  periodAt,
  renewedTerm,
  termLength,
} from "./contract-period";

const d = (s: string): Date => new Date(s);

describe("addMonths", () => {
  it("clamps to the end of shorter months, including leap years", () => {
    expect(addMonths(d("2026-01-31T00:00:00Z"), 1)).toEqual(d("2026-02-28T00:00:00Z"));
    expect(addMonths(d("2028-01-31T00:00:00Z"), 1)).toEqual(d("2028-02-29T00:00:00Z"));
    expect(addMonths(d("2026-01-31T00:00:00Z"), 3)).toEqual(d("2026-04-30T00:00:00Z"));
    expect(addMonths(d("2026-11-15T09:30:00Z"), 2)).toEqual(d("2027-01-15T09:30:00Z"));
    expect(addMonths(d("2026-03-31T00:00:00Z"), -1)).toEqual(d("2026-02-28T00:00:00Z"));
  });
});

describe("periodAt", () => {
  const monthly = { startsAt: d("2026-01-31T00:00:00Z"), endsAt: null, coveragePeriod: "monthly" };

  it("aligns monthly periods to the start date and counts each from the anchor (no drift)", () => {
    expect(periodAt(monthly, d("2026-02-10T00:00:00Z"))).toEqual({
      start: d("2026-01-31T00:00:00Z"),
      end: d("2026-02-28T00:00:00Z"),
    });
    expect(periodAt(monthly, d("2026-03-05T00:00:00Z"))).toEqual({
      start: d("2026-02-28T00:00:00Z"),
      end: d("2026-03-31T00:00:00Z"),
    });
    // March 31, not March 28: periods are counted from Jan 31, not chained.
    expect(periodAt(monthly, d("2026-03-31T00:00:00Z")).start).toEqual(d("2026-03-31T00:00:00Z"));
    expect(periodAt(monthly, d("2026-04-30T12:00:00Z"))).toEqual({
      start: d("2026-04-30T00:00:00Z"),
      end: d("2026-05-31T00:00:00Z"),
    });
  });

  it("treats the period end as exclusive", () => {
    const c = { startsAt: d("2026-01-15T00:00:00Z"), endsAt: null, coveragePeriod: "monthly" };
    expect(periodAt(c, d("2026-02-15T00:00:00Z")).start).toEqual(d("2026-02-15T00:00:00Z"));
    expect(periodAt(c, d("2026-02-14T23:59:59Z")).start).toEqual(d("2026-01-15T00:00:00Z"));
  });

  it("handles quarterly and yearly periods and cuts the last one at the contract end", () => {
    const q = { startsAt: d("2026-01-01T00:00:00Z"), endsAt: d("2026-08-15T00:00:00Z"), coveragePeriod: "quarterly" };
    expect(periodAt(q, d("2026-05-20T00:00:00Z"))).toEqual({ start: d("2026-04-01T00:00:00Z"), end: d("2026-07-01T00:00:00Z") });
    expect(periodAt(q, d("2026-07-20T00:00:00Z"))).toEqual({ start: d("2026-07-01T00:00:00Z"), end: d("2026-08-15T00:00:00Z") });
    const y = { startsAt: d("2024-02-29T00:00:00Z"), endsAt: null, coveragePeriod: "yearly" };
    expect(periodAt(y, d("2026-03-01T00:00:00Z"))).toEqual({ start: d("2026-02-28T00:00:00Z"), end: d("2027-02-28T00:00:00Z") });
  });

  it("returns the whole contract for term coverage and the first period before the start", () => {
    const t = { startsAt: d("2026-01-01T00:00:00Z"), endsAt: d("2027-01-01T00:00:00Z"), coveragePeriod: "term" };
    expect(periodAt(t, d("2026-06-01T00:00:00Z"))).toEqual({ start: t.startsAt, end: t.endsAt });
    const m = { startsAt: d("2026-05-10T00:00:00Z"), endsAt: null, coveragePeriod: "monthly" };
    expect(periodAt(m, d("2026-04-01T00:00:00Z"))).toEqual({ start: d("2026-05-10T00:00:00Z"), end: d("2026-06-10T00:00:00Z") });
  });
});

describe("computeUsage", () => {
  it("reports remaining time while under the allowance", () => {
    expect(computeUsage({ coveredMinutes: 600, overageRateCents: 12000 }, 90 * 60)).toEqual({
      coveredMinutes: 600,
      usedMinutes: 90,
      remainingMinutes: 510,
      overageMinutes: 0,
      overageCents: 0,
    });
  });

  it("reports overage and its cost past the allowance", () => {
    expect(computeUsage({ coveredMinutes: 60, overageRateCents: 12000 }, 91 * 60)).toMatchObject({
      remainingMinutes: 0,
      overageMinutes: 31,
      overageCents: 6200,
    });
    expect(computeUsage({ coveredMinutes: 60, overageRateCents: null }, 91 * 60).overageCents).toBeNull();
  });

  it("has no allowance when the contract includes no hours", () => {
    expect(computeUsage({ coveredMinutes: null, overageRateCents: null }, 3600)).toMatchObject({
      coveredMinutes: null,
      usedMinutes: 60,
      remainingMinutes: null,
    });
  });
});

describe("termLength / renewedTerm", () => {
  it("measures calendar-aligned terms in months, others in milliseconds", () => {
    expect(termLength(d("2026-01-01T00:00:00Z"), d("2027-01-01T00:00:00Z"))).toEqual({ months: 12 });
    expect(termLength(d("2026-01-01T00:00:00Z"), d("2026-01-31T00:00:00Z"))).toEqual({ ms: 30 * 86_400_000 });
  });

  it("extends by the original term from the old end date", () => {
    const c = { startsAt: d("2025-11-01T00:00:00Z"), endsAt: d("2026-11-01T00:00:00Z") };
    expect(renewedTerm(c, d("2026-10-31T00:00:00Z"))).toBeNull();
    expect(renewedTerm(c, d("2026-11-01T00:00:00Z"))).toEqual({
      startsAt: d("2026-11-01T00:00:00Z"),
      endsAt: d("2027-11-01T00:00:00Z"),
      renewals: 1,
    });
  });

  it("catches up over several missed ends", () => {
    const c = { startsAt: d("2026-01-01T00:00:00Z"), endsAt: d("2026-04-01T00:00:00Z") };
    expect(renewedTerm(c, d("2026-10-15T00:00:00Z"))).toEqual({
      startsAt: d("2026-10-01T00:00:00Z"),
      endsAt: d("2027-01-01T00:00:00Z"),
      renewals: 3,
    });
  });
});

describe("needsRenewalNotice", () => {
  const base = {
    status: "active",
    startsAt: d("2026-01-01T00:00:00Z"),
    endsAt: d("2026-11-20T00:00:00Z"),
    renewalNoticeDays: 30,
    renewalNotifiedAt: null as Date | null,
  };
  const now = d("2026-10-31T07:00:00Z");

  it("selects active contracts ending inside their own notice window", () => {
    expect(needsRenewalNotice(base, now)).toBe(true);
    expect(needsRenewalNotice({ ...base, renewalNoticeDays: 10 }, now)).toBe(false);
    expect(needsRenewalNotice({ ...base, status: "draft" }, now)).toBe(false);
    expect(needsRenewalNotice({ ...base, endsAt: null }, now)).toBe(false);
    expect(needsRenewalNotice({ ...base, endsAt: d("2026-10-30T00:00:00Z") }, now)).toBe(false);
  });

  it("notifies once per term", () => {
    expect(needsRenewalNotice({ ...base, renewalNotifiedAt: d("2026-10-25T07:00:00Z") }, now)).toBe(false);
    expect(needsRenewalNotice({ ...base, renewalNotifiedAt: d("2025-12-01T07:00:00Z") }, now)).toBe(true);
  });
});
