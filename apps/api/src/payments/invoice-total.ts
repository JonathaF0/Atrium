import { lineTaxCents } from "@atrium/shared";

interface TotalLine {
  quantity: number;
  unitPrice: number;
  taxRateBps?: number | null;
}

/** Sum of tax on every line item (0 when no line carries a tax rate). */
export function calculateInvoiceTax(lineItems: TotalLine[]): number {
  return lineItems.reduce(
    (sum, item) => sum + lineTaxCents(item.quantity, item.unitPrice, item.taxRateBps ?? 0),
    0,
  );
}

/**
 * Calculate the total amount in cents for an invoice, tax included.
 * Works for both uploaded (fixed amount) and itemized (line items) invoices.
 */
export function calculateInvoiceTotal(invoice: {
  type: string;
  amount?: number | null;
  lineItems: TotalLine[];
}): number {
  if (invoice.type === "uploaded" && invoice.amount != null) {
    return invoice.amount;
  }
  return (
    invoice.lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) +
    calculateInvoiceTax(invoice.lineItems)
  );
}
