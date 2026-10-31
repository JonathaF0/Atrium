import { describe, it, expect } from "bun:test";
import { Prisma } from "@atrium/database";
import {
  AGING_BUCKETS,
  agingBucket,
  agingBucketSql,
  contractAllowanceMinutes,
  invoiceTotalCents,
  invoiceTotalSql,
  monthlyFactor,
  monthlyRecurringCents,
  percent,
  percentileCont,
} from "./report-math";

describe("percentileCont", () => {
  it("is null for no values", () => {
    expect(percentileCont([], 0.5)).toBeNull();
  });

  it("returns the single value", () => {
    expect(percentileCont([7], 0.9)).toBe(7);
  });

  it("interpolates like Postgres percentile_cont", () => {
    // percentile_cont(0.5) of 1,2,3,4 = 2.5; percentile_cont(0.9) = 3.7
    expect(percentileCont([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentileCont([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 10);
    expect(percentileCont([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentileCont([0, 10], 0.9)).toBe(9);
  });

  it("clamps p", () => {
    expect(percentileCont([1, 2, 3], 2)).toBe(3);
    expect(percentileCont([1, 2, 3], -1)).toBe(1);
  });
});

describe("percent", () => {
  it("rounds to one decimal and is null without a denominator", () => {
    expect(percent(2, 3)).toBe(66.7);
    expect(percent(0, 0)).toBeNull();
    expect(percent(5, 5)).toBe(100);
  });
});

describe("invoiceTotalCents", () => {
  it("uses amount for uploaded invoices", () => {
    expect(invoiceTotalCents({ type: "uploaded", amount: 12345, lineItems: [] })).toBe(12345);
    expect(invoiceTotalCents({ type: "uploaded", amount: null, lineItems: [] })).toBe(0);
  });

  it("sums lines and per-line tax", () => {
    const total = invoiceTotalCents({
      type: "itemized",
      amount: null,
      lineItems: [
        { quantity: 2, unitPrice: 10000, taxRateBps: 825 }, // 20000 + 1650
        { quantity: 1, unitPrice: 333, taxRateBps: 1000 }, // 333 + 33.3 → 33
        { quantity: 3, unitPrice: 500, taxRateBps: 0 }, // 1500
      ],
    });
    expect(total).toBe(20000 + 1650 + 333 + 33 + 1500);
  });

  it("rounds each line's tax half up", () => {
    // 1 × 50 at 10% = 5.0; 1 × 25 at 10% = 2.5 → 3
    expect(invoiceTotalCents({ type: "itemized", amount: 999, lineItems: [{ quantity: 1, unitPrice: 25, taxRateBps: 1000 }] })).toBe(28);
  });

  it("has a SQL counterpart over the given alias", () => {
    const sql = invoiceTotalSql("i");
    expect(sql.sql).toContain(`"i".type = 'uploaded'`);
    expect(sql.sql).toContain(`li."taxRateBps"`);
    expect(sql.values).toEqual([]);
  });
});

describe("aging buckets", () => {
  it("assigns days past due to buckets", () => {
    expect(agingBucket(null)).toBe("current");
    expect(agingBucket(-10)).toBe("current");
    expect(agingBucket(0)).toBe("current");
    expect(agingBucket(1)).toBe("d1_30");
    expect(agingBucket(30)).toBe("d1_30");
    expect(agingBucket(31)).toBe("d31_60");
    expect(agingBucket(60)).toBe("d31_60");
    expect(agingBucket(61)).toBe("d61_90");
    expect(agingBucket(90)).toBe("d61_90");
    expect(agingBucket(91)).toBe("d90_plus");
    expect(agingBucket(1000)).toBe("d90_plus");
  });

  it("builds the same thresholds in SQL", () => {
    const sql = agingBucketSql(Prisma.sql`d`).sql;
    expect(sql).toContain("WHEN d IS NULL THEN 'current'");
    for (const b of AGING_BUCKETS) {
      if (b.maxDays !== null) expect(sql).toContain(`WHEN d <= ${b.maxDays} THEN '${b.key}'`);
    }
    expect(sql).toContain("ELSE 'd90_plus'");
  });
});

describe("monthly recurring revenue", () => {
  it("normalises intervals to a month", () => {
    expect(monthlyFactor("monthly", 1)).toBe(1);
    expect(monthlyFactor("monthly", 2)).toBe(0.5);
    expect(monthlyFactor("quarterly", 1)).toBeCloseTo(1 / 3, 10);
    expect(monthlyFactor("yearly", 1)).toBeCloseTo(1 / 12, 10);
    expect(monthlyFactor("weekly", 1)).toBeCloseTo(52 / 12, 10);
    expect(monthlyFactor("weekly", 2)).toBeCloseTo(26 / 12, 10);
  });

  it("treats a missing count as 1 and unknown intervals as 0", () => {
    expect(monthlyFactor("monthly", 0)).toBe(1);
    expect(monthlyFactor("daily", 1)).toBe(0);
  });

  it("rounds to whole cents", () => {
    expect(monthlyRecurringCents(120000, "yearly", 1)).toBe(10000);
    expect(monthlyRecurringCents(30000, "quarterly", 1)).toBe(10000);
    expect(monthlyRecurringCents(1000, "weekly", 1)).toBe(4333);
  });
});

describe("contractAllowanceMinutes", () => {
  const day = (s: string): Date => new Date(`${s}T00:00:00Z`);
  const monthDays = 365.25 / 12;

  it("prorates a monthly allowance by the range length", () => {
    const c = { startsAt: day("2025-01-01"), endsAt: null, coveredMinutes: 600, coveragePeriod: "monthly" };
    // 30 days of a 30.4375-day month.
    expect(contractAllowanceMinutes(c, day("2026-10-01"), day("2026-10-31"))).toBe(Math.round((600 * 30) / monthDays));
  });

  it("only counts the part of the range the contract runs", () => {
    const c = { startsAt: day("2026-10-16"), endsAt: day("2026-10-26"), coveredMinutes: 600, coveragePeriod: "monthly" };
    expect(contractAllowanceMinutes(c, day("2026-10-01"), day("2026-11-01"))).toBe(Math.round((600 * 10) / monthDays));
  });

  it("is 0 outside the contract or without covered minutes", () => {
    const c = { startsAt: day("2026-11-01"), endsAt: null, coveredMinutes: 600, coveragePeriod: "monthly" };
    expect(contractAllowanceMinutes(c, day("2026-10-01"), day("2026-11-01"))).toBe(0);
    expect(contractAllowanceMinutes({ ...c, startsAt: day("2026-01-01"), coveredMinutes: null }, day("2026-10-01"), day("2026-11-01"))).toBe(0);
  });

  it("uses quarter and year lengths", () => {
    const q = { startsAt: day("2025-01-01"), endsAt: null, coveredMinutes: 900, coveragePeriod: "quarterly" };
    expect(contractAllowanceMinutes(q, day("2026-01-01"), day("2026-01-01"))).toBe(0);
    const yearStart = day("2026-01-01");
    const yearEnd = new Date(yearStart.getTime() + 365.25 * 86_400_000);
    expect(contractAllowanceMinutes({ ...q, coveragePeriod: "yearly", coveredMinutes: 1200 }, yearStart, yearEnd)).toBe(1200);
    const quarterEnd = new Date(yearStart.getTime() + (365.25 / 4) * 86_400_000);
    expect(contractAllowanceMinutes(q, yearStart, quarterEnd)).toBe(900);
  });

  it("spreads a term allowance over the term", () => {
    const c = { startsAt: day("2026-01-01"), endsAt: day("2026-01-11"), coveredMinutes: 1000, coveragePeriod: "term" };
    expect(contractAllowanceMinutes(c, day("2026-01-06"), day("2026-02-01"))).toBe(500);
    expect(contractAllowanceMinutes({ ...c, endsAt: null }, day("2026-01-06"), day("2026-02-01"))).toBe(1000);
  });
});
