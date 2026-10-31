import { describe, expect, it } from "bun:test";
import { computeEstimateTotals, lineTaxCents, type EstimateLineLike } from "@atrium/shared";
import {
  CLIENT_OPEN_STATUSES,
  CLIENT_VISIBLE_STATUSES,
  REVISABLE_STATUSES,
  SENDABLE_STATUSES,
  estimateMargin,
  estimateTotals,
  inList,
  invoiceLinesFromEstimate,
  planInvoices,
  recurringByInterval,
  splitByPercentages,
} from "./estimate-math";

function line(over: Partial<EstimateLineLike> = {}): EstimateLineLike {
  return {
    quantity: 1,
    unitPriceCents: 10000,
    taxRateBps: 0,
    taxable: true,
    optional: false,
    selected: true,
    billingType: "fixed",
    ...over,
  };
}

const none = { type: null, value: null } as const;

describe("lineTaxCents", () => {
  it("is zero without a rate", () => {
    expect(lineTaxCents(3, 1000, 0)).toBe(0);
  });
  it("rounds to the nearest cent", () => {
    expect(lineTaxCents(1, 999, 825)).toBe(82); // 82.4175
    expect(lineTaxCents(2, 1250, 2000)).toBe(500);
    expect(lineTaxCents(1, 1, 5000)).toBe(1); // 0.5 rounds up
  });
});

describe("computeEstimateTotals", () => {
  it("sums one-time lines and ignores unselected optional items", () => {
    const t = computeEstimateTotals(
      [line(), line({ quantity: 2.5, unitPriceCents: 4000 }), line({ optional: true, selected: false, unitPriceCents: 99999 })],
      none,
      null,
    );
    expect(t.oneTimeSubtotalCents).toBe(20000);
    expect(t.totalCents).toBe(20000);
    expect(t.discountCents).toBe(0);
    expect(t.taxCents).toBe(0);
  });

  it("counts a selected optional item", () => {
    const t = computeEstimateTotals([line(), line({ optional: true, selected: true, unitPriceCents: 5000 })], none, null);
    expect(t.totalCents).toBe(15000);
  });

  it("keeps recurring items out of the one-time total", () => {
    const t = computeEstimateTotals(
      [line(), line({ billingType: "recurring", unitPriceCents: 2500, quantity: 4, taxRateBps: 1000 })],
      none,
      null,
    );
    expect(t.recurringSubtotalCents).toBe(10000);
    expect(t.oneTimeSubtotalCents).toBe(10000);
    expect(t.taxCents).toBe(0);
    expect(t.totalCents).toBe(10000);
  });

  it("applies tax only to taxable lines with a rate", () => {
    const t = computeEstimateTotals(
      [line({ taxRateBps: 1000 }), line({ taxable: false, taxRateBps: 1000 }), line({ taxRateBps: 0 })],
      none,
      null,
    );
    expect(t.taxCents).toBe(1000);
    expect(t.totalCents).toBe(31000);
  });

  it("applies a percent discount before tax, proportionally", () => {
    // 10% off 200.00 = 20.00; tax 10% on the taxed half after discount = 9.00
    const t = computeEstimateTotals([line({ taxRateBps: 1000 }), line()], { type: "percent", value: 1000 }, null);
    expect(t.discountCents).toBe(2000);
    expect(t.taxCents).toBe(900);
    expect(t.totalCents).toBe(20000 - 2000 + 900);
  });

  it("caps an amount discount at the subtotal", () => {
    const t = computeEstimateTotals([line()], { type: "amount", value: 50000 }, null);
    expect(t.discountCents).toBe(10000);
    expect(t.totalCents).toBe(0);
  });

  it("computes the deposit on the tax-inclusive total", () => {
    const t = computeEstimateTotals([line({ taxRateBps: 2000 })], none, 30);
    expect(t.totalCents).toBe(12000);
    expect(t.depositCents).toBe(3600);
  });
});

describe("estimate status rules", () => {
  it("only drafts and change requests can be sent", () => {
    expect(inList(SENDABLE_STATUSES, "draft")).toBe(true);
    expect(inList(SENDABLE_STATUSES, "changes_requested")).toBe(true);
    for (const s of ["sent", "viewed", "accepted", "declined", "expired", "superseded", "converted"]) {
      expect(inList(SENDABLE_STATUSES, s)).toBe(false);
    }
  });

  it("clients never see drafts or superseded versions", () => {
    expect(inList(CLIENT_VISIBLE_STATUSES, "draft")).toBe(false);
    expect(inList(CLIENT_VISIBLE_STATUSES, "superseded")).toBe(false);
    expect(inList(CLIENT_VISIBLE_STATUSES, "converted")).toBe(true);
  });

  it("settled estimates are closed to the client and can't be revised", () => {
    for (const s of ["accepted", "converted", "declined", "expired"]) expect(inList(CLIENT_OPEN_STATUSES, s)).toBe(false);
    expect(inList(REVISABLE_STATUSES, "accepted")).toBe(false);
    expect(inList(REVISABLE_STATUSES, "converted")).toBe(false);
    expect(inList(REVISABLE_STATUSES, "declined")).toBe(true);
  });
});

type Stored = Parameters<typeof estimateTotals>[0][number] & { name: string; unit: string };

function stored(over: Partial<Stored> = {}): Stored {
  return {
    name: "Work",
    unit: "each",
    quantity: 1,
    unitPriceCents: 10000,
    costCents: null,
    taxable: true,
    taxRateBps: 0,
    optional: false,
    selected: true,
    billingType: "fixed",
    recurringInterval: null,
    ...over,
  };
}

const noDiscount = { discountType: null, discountValue: null, depositPercent: null };

describe("recurringByInterval and margin", () => {
  it("groups selected recurring lines by interval", () => {
    const r = recurringByInterval([
      stored({ billingType: "recurring", recurringInterval: "monthly", unitPriceCents: 1000, quantity: 3 }),
      stored({ billingType: "recurring", recurringInterval: "yearly", unitPriceCents: 50000 }),
      stored({ billingType: "recurring", recurringInterval: "monthly", optional: true, selected: false, unitPriceCents: 777 }),
      stored(),
    ]);
    expect(r).toEqual({ monthly: 3000, yearly: 50000 });
  });

  it("computes margin from cost on one-time lines and flags missing costs", () => {
    const m = estimateMargin(
      [stored({ costCents: 6000 }), stored({ quantity: 2, unitPriceCents: 5000 }), stored({ billingType: "recurring", costCents: 1 })],
      noDiscount,
    );
    expect(m.priceCents).toBe(20000);
    expect(m.costCents).toBe(6000);
    expect(m.marginCents).toBe(14000);
    expect(m.marginPercent).toBe(70);
    expect(m.missingCost).toBe(1);
  });
});

describe("splitByPercentages", () => {
  it("always adds up to the total", () => {
    expect(splitByPercentages(10001, [33, 33, 34])).toEqual([3300, 3300, 3401]);
    expect(splitByPercentages(999, [50, 50]).reduce((a, b) => a + b, 0)).toBe(999);
  });
  it("rejects percentages that don't add up to 100", () => {
    expect(() => splitByPercentages(100, [50, 40])).toThrow();
  });
});

function invoiceTotal(lines: Array<{ quantity: number; unitPrice: number; taxRateBps: number }>): number {
  return lines.reduce((s, l) => s + l.quantity * l.unitPrice + lineTaxCents(l.quantity, l.unitPrice, l.taxRateBps), 0);
}

describe("planInvoices", () => {
  const lines = [
    stored({ name: "Setup", quantity: 2, unitPriceCents: 15000, taxRateBps: 1000 }),
    stored({ name: "Consulting", quantity: 1.5, unit: "hour", unitPriceCents: 12000, taxable: false }),
    stored({ name: "Extra", optional: true, selected: false, unitPriceCents: 99999 }),
    stored({ name: "Monitoring", billingType: "recurring", recurringInterval: "monthly", unitPriceCents: 4000 }),
  ];

  it("full: one itemized invoice that matches the estimate total, recurring excluded", () => {
    const [plan, ...rest] = planInvoices(lines, noDiscount, "full", {});
    expect(rest).toHaveLength(0);
    expect(plan.lineItems.map((l) => l.description)).toEqual(["Setup", "Consulting (1.5 hour)"]);
    expect(plan.lineItems[0]).toMatchObject({ quantity: 2, unitPrice: 15000, taxRateBps: 1000 });
    expect(plan.lineItems[1]).toMatchObject({ quantity: 1, unitPrice: 18000, taxRateBps: 0 });
    expect(invoiceTotal(plan.lineItems)).toBe(estimateTotals(lines, noDiscount).totalCents);
  });

  it("full with a discount: no negative lines, same total as the estimate", () => {
    const e = { discountType: "percent", discountValue: 1000, depositPercent: null };
    const items = invoiceLinesFromEstimate(lines, e);
    expect(items.every((l) => l.unitPrice >= 0)).toBe(true);
    const pre = items.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const t = estimateTotals(lines, e);
    expect(pre).toBe(t.oneTimeSubtotalCents - t.discountCents);
    expect(Math.abs(invoiceTotal(items) - t.totalCents)).toBeLessThanOrEqual(1);
  });

  it("deposit: two invoices whose pre-tax amounts add up to the estimate", () => {
    const plans = planInvoices(lines, noDiscount, "deposit", { depositPercent: 30 });
    expect(plans.map((p) => p.label)).toEqual(["Deposit (30%)", "Balance (70%)"]);
    const pre = plans.map((p) => p.lineItems.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
    expect(pre[0] + pre[1]).toBe(48000);
    expect(pre[0]).toBe(14400);
    // Each part keeps the taxed/untaxed split, so tax is spread proportionally.
    expect(plans[0].lineItems.some((l) => l.taxRateBps === 1000)).toBe(true);
    const total = plans.reduce((s, p) => s + invoiceTotal(p.lineItems), 0);
    expect(Math.abs(total - estimateTotals(lines, noDiscount).totalCents)).toBeLessThanOrEqual(1);
  });

  it("milestones: one invoice per percentage", () => {
    const plans = planInvoices(lines, noDiscount, "milestones", {
      milestones: [{ label: "Kickoff", percent: 50 }, { percent: 25 }, { percent: 25 }],
    });
    expect(plans.map((p) => p.label)).toEqual(["Kickoff", "Milestone 2 (25%)", "Milestone 3 (25%)"]);
    const pre = plans.map((p) => p.lineItems.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
    expect(pre).toEqual([24000, 12000, 12000]);
  });

  it("rejects milestones that don't add up and invalid deposits", () => {
    expect(() => planInvoices(lines, noDiscount, "milestones", { milestones: [{ percent: 50 }, { percent: 40 }] })).toThrow();
    expect(() => planInvoices(lines, noDiscount, "deposit", { depositPercent: 0 })).toThrow();
    expect(() => planInvoices(lines, noDiscount, "deposit", { depositPercent: 100 })).toThrow();
  });

  it("returns no invoices when only recurring items are selected", () => {
    expect(planInvoices([lines[3]], noDiscount, "full", {})).toEqual([]);
  });
});
