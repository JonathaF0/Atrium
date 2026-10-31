import { describe, expect, test } from "bun:test";
import { calculateInvoiceTax, calculateInvoiceTotal } from "./invoice-total";

describe("calculateInvoiceTotal", () => {
  test("sums line items when no line is taxed", () => {
    expect(
      calculateInvoiceTotal({
        type: "itemized",
        lineItems: [
          { quantity: 2, unitPrice: 1500 },
          { quantity: 1, unitPrice: 250, taxRateBps: 0 },
        ],
      }),
    ).toBe(3250);
  });

  test("adds per-line tax rounded to the cent", () => {
    // 3 x 33.33 = 99.99; 8.25% = 8.249175 -> 8.25
    const lines = [
      { quantity: 3, unitPrice: 3333, taxRateBps: 825 },
      { quantity: 1, unitPrice: 10000, taxRateBps: 0 },
    ];
    expect(calculateInvoiceTax(lines)).toBe(825);
    expect(calculateInvoiceTotal({ type: "itemized", lineItems: lines })).toBe(9999 + 825 + 10000);
  });

  test("uses the stored amount for uploaded invoices, ignoring line tax", () => {
    expect(
      calculateInvoiceTotal({ type: "uploaded", amount: 5000, lineItems: [{ quantity: 1, unitPrice: 1, taxRateBps: 2000 }] }),
    ).toBe(5000);
  });

  test("treats a missing or null rate as untaxed", () => {
    expect(calculateInvoiceTax([{ quantity: 1, unitPrice: 1000, taxRateBps: null }, { quantity: 1, unitPrice: 1000 }])).toBe(0);
  });
});
