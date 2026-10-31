import { describe, expect, it } from "bun:test";
import { currencySymbol, formatCurrency, formatTaxRate, invoiceTax, invoiceTotal } from "./format";

describe("formatCurrency", () => {
  it("defaults to USD", () => {
    expect(formatCurrency(123456)).toBe("$1,234.56");
  });

  it("formats in the given currency", () => {
    expect(formatCurrency(123456, "eur")).toContain("€");
    expect(formatCurrency(123456, "gbp")).toContain("£");
  });

  it("accepts upper or lower case codes", () => {
    expect(formatCurrency(100, "EUR")).toBe(formatCurrency(100, "eur"));
  });
});

describe("currencySymbol", () => {
  it("returns the symbol for a currency", () => {
    expect(currencySymbol()).toBe("$");
    expect(currencySymbol("eur")).toBe("€");
    expect(currencySymbol("gbp")).toBe("£");
  });

  it("falls back to $ for an invalid code", () => {
    expect(currencySymbol("nope")).toBe("$");
  });
});

describe("invoiceTotal", () => {
  it("uses the amount of an uploaded invoice", () => {
    expect(invoiceTotal({ type: "uploaded", amount: 5000, lineItems: [] })).toBe(5000);
  });

  it("sums line items when the invoice was built in Atrium", () => {
    const lineItems = [
      { quantity: 2, unitPrice: 1500 },
      { quantity: 1, unitPrice: 250 },
    ];
    expect(invoiceTotal({ type: "standard", amount: null, lineItems })).toBe(3250);
  });

  it("adds per-line tax", () => {
    const lineItems = [
      { quantity: 3, unitPrice: 3333, taxRateBps: 825 },
      { quantity: 1, unitPrice: 1000, taxRateBps: 0 },
    ];
    expect(invoiceTax(lineItems)).toBe(825);
    expect(invoiceTotal({ type: "itemized", lineItems })).toBe(9999 + 825 + 1000);
  });

  it("formats tax rates without trailing zeros", () => {
    expect(formatTaxRate(825)).toBe("8.25%");
    expect(formatTaxRate(1000)).toBe("10%");
    expect(formatTaxRate(750)).toBe("7.5%");
  });

  it("is 0 when there is nothing to add up", () => {
    expect(invoiceTotal({ type: "uploaded", amount: null })).toBe(0);
    expect(invoiceTotal({ type: "standard", amount: null })).toBe(0);
  });
});
