import { DEFAULT_CURRENCY, formatMoney, lineTaxCents } from "@atrium/shared";

export function formatCurrency(cents: number, currency?: string): string {
  return formatMoney(cents, currency);
}

interface InvoiceAmounts {
  type: string;
  amount?: number | null;
  lineItems?: { quantity: number; unitPrice: number; taxRateBps?: number | null }[];
}

/** Tax across an invoice's line items in cents. */
export function invoiceTax(lineItems: { quantity: number; unitPrice: number; taxRateBps?: number | null }[] = []): number {
  return lineItems.reduce((sum, li) => sum + lineTaxCents(li.quantity, li.unitPrice, li.taxRateBps ?? 0), 0);
}

/** An invoice's total in cents: the stored amount for uploaded PDFs, otherwise its line items plus tax. */
export function invoiceTotal(invoice: InvoiceAmounts): number {
  if (invoice.type === "uploaded") return invoice.amount ?? 0;
  const items = invoice.lineItems ?? [];
  return items.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0) + invoiceTax(items);
}

/** 825 basis points -> "8.25%". */
export function formatTaxRate(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** The symbol for a currency, e.g. "€" for "eur". */
export function currencySymbol(currency: string = DEFAULT_CURRENCY): string {
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? "$";
  } catch (err) {
    console.error(`Invalid currency code "${currency}"`, err);
    return "$";
  }
}
