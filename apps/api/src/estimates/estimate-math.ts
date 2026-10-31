import {
  computeEstimateTotals,
  type BillingType,
  type EstimateLineLike,
  type EstimateTotals,
} from "@atrium/shared";

/** Statuses in which a client can see an estimate version. */
export const CLIENT_VISIBLE_STATUSES = [
  "sent",
  "viewed",
  "changes_requested",
  "accepted",
  "declined",
  "expired",
  "converted",
] as const;

/** Statuses in which the client can still respond (toggle options, accept, decline, request changes). */
export const CLIENT_OPEN_STATUSES = ["sent", "viewed", "changes_requested"] as const;

/** Statuses an estimate can be sent from. */
export const SENDABLE_STATUSES = ["draft", "changes_requested"] as const;

/** Staff may edit the content only before the client has it. */
export const EDITABLE_STATUSES = ["draft"] as const;

/** A new version can be drafted from any version the client has seen, but not once it is settled. */
export const REVISABLE_STATUSES = ["sent", "viewed", "changes_requested", "declined", "expired"] as const;

/** Statuses the expiry cron moves to "expired". */
export const EXPIRABLE_STATUSES = ["sent", "viewed"] as const;

export function inList<T extends string>(list: readonly T[], status: string): boolean {
  return (list as readonly string[]).includes(status);
}

export interface StoredLine {
  quantity: number | { toString(): string };
  unitPriceCents: number;
  costCents?: number | null;
  taxRateBps: number;
  taxable: boolean;
  optional: boolean;
  selected: boolean;
  billingType: string;
  recurringInterval?: string | null;
}

export interface StoredDiscount {
  discountType: string | null;
  discountValue: number | null;
  depositPercent: number | null;
}

export function toLineLike(l: StoredLine): EstimateLineLike {
  return {
    quantity: Number(l.quantity),
    unitPriceCents: l.unitPriceCents,
    taxRateBps: l.taxable ? l.taxRateBps : 0,
    taxable: l.taxable,
    optional: l.optional,
    selected: l.selected,
    billingType: (l.billingType as BillingType) ?? "fixed",
  };
}

export function estimateTotals(lines: StoredLine[], e: StoredDiscount): EstimateTotals {
  const type = e.discountType === "percent" || e.discountType === "amount" ? e.discountType : null;
  return computeEstimateTotals(lines.map(toLineLike), { type, value: e.discountValue }, e.depositPercent);
}

/** Recurring subtotals (selected items only) per interval, in cents per period, tax not included. */
export function recurringByInterval(lines: StoredLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    if (l.billingType !== "recurring" || (l.optional && !l.selected)) continue;
    const interval = l.recurringInterval || "monthly";
    out[interval] = (out[interval] ?? 0) + Math.round(Number(l.quantity) * l.unitPriceCents);
  }
  return out;
}

/** Internal margin on one-time selected items: price after discount vs cost. Staff only. */
export function estimateMargin(
  lines: StoredLine[],
  e: StoredDiscount,
): { priceCents: number; costCents: number; marginCents: number; marginPercent: number | null; missingCost: number } {
  const totals = estimateTotals(lines, e);
  const included = lines.filter((l) => (!l.optional || l.selected) && l.billingType !== "recurring");
  const costCents = included.reduce((sum, l) => sum + Math.round(Number(l.quantity) * (l.costCents ?? 0)), 0);
  const missingCost = included.filter((l) => l.costCents == null).length;
  const priceCents = totals.oneTimeSubtotalCents - totals.discountCents;
  const marginCents = priceCents - costCents;
  return {
    priceCents,
    costCents,
    marginCents,
    marginPercent: priceCents > 0 ? Math.round((marginCents / priceCents) * 1000) / 10 : null,
    missingCost,
  };
}

/**
 * Splits `total` cents by whole-number percentages. Every share is rounded down
 * and the remainder goes to the last share, so the parts always add up to the total.
 */
export function splitByPercentages(total: number, percentages: number[]): number[] {
  if (percentages.length === 0) return [];
  const sum = percentages.reduce((a, b) => a + b, 0);
  if (sum !== 100) throw new Error("Percentages must add up to 100");
  const parts = percentages.map((p) => Math.floor((total * p) / 100));
  const allocated = parts.reduce((a, b) => a + b, 0);
  parts[parts.length - 1] += total - allocated;
  return parts;
}

export interface InvoiceLinePlan {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateBps: number;
}

export interface InvoicePlan {
  label: string;
  lineItems: InvoiceLinePlan[];
}

interface ConvertibleLine extends StoredLine {
  name: string;
  unit: string;
}

/**
 * One invoice line per selected one-time estimate line. Invoice quantities are
 * whole numbers, so a fractional quantity becomes a single line priced at the
 * line total with the quantity in the description.
 */
export function invoiceLinesFromEstimate(lines: ConvertibleLine[], e: StoredDiscount): InvoiceLinePlan[] {
  const included = lines.filter((l) => (!l.optional || l.selected) && l.billingType !== "recurring");
  const totals = estimateTotals(lines, e);
  if (totals.discountCents <= 0) {
    return included.map((l) => {
      const qty = Number(l.quantity);
      const taxRateBps = l.taxable ? l.taxRateBps : 0;
      if (Number.isInteger(qty)) {
        return { description: l.name, quantity: qty, unitPrice: l.unitPriceCents, taxRateBps };
      }
      return {
        description: `${l.name} (${qty} ${l.unit})`,
        quantity: 1,
        unitPrice: Math.round(qty * l.unitPriceCents),
        taxRateBps,
      };
    });
  }
  // Invoice lines can't be negative, so the discount is applied to each line
  // (as the estimate does before tax) and the last line absorbs the rounding.
  const factor = 1 - totals.discountCents / totals.oneTimeSubtotalCents;
  const out: InvoiceLinePlan[] = included.map((l) => {
    const qty = Number(l.quantity);
    return {
      description: qty === 1 ? `${l.name} (discounted)` : `${l.name} (${qty} ${l.unit}, discounted)`,
      quantity: 1,
      unitPrice: Math.round(qty * l.unitPriceCents * factor),
      taxRateBps: l.taxable ? l.taxRateBps : 0,
    };
  });
  const target = totals.oneTimeSubtotalCents - totals.discountCents;
  const diff = target - out.reduce((s, l) => s + l.unitPrice, 0);
  if (out.length > 0 && diff !== 0) {
    const last = out[out.length - 1];
    last.unitPrice = Math.max(0, last.unitPrice + diff);
  }
  return out.filter((l) => l.unitPrice > 0);
}

/**
 * Invoice lines that bill `fraction` of the estimate: one line per tax rate,
 * so the tax on the part invoice is the same fraction of the estimate's tax.
 */
export function proportionalLines(full: InvoiceLinePlan[], amounts: number, total: number, label: string): InvoiceLinePlan[] {
  if (total <= 0) return [];
  const byRate = new Map<number, number>();
  for (const l of full) byRate.set(l.taxRateBps, (byRate.get(l.taxRateBps) ?? 0) + l.quantity * l.unitPrice);
  const rates = [...byRate.entries()].filter(([, v]) => v !== 0);
  const subtotal = rates.reduce((s, [, v]) => s + v, 0);
  if (subtotal <= 0) return [];
  // `amounts` is a share of the tax-inclusive total; bill the same share of each pre-tax group.
  const fraction = amounts / total;
  let remaining = Math.round(subtotal * fraction);
  return rates.map(([rate, value], i) => {
    const part = i === rates.length - 1 ? remaining : Math.round(value * fraction);
    remaining -= part;
    return {
      description: rates.length > 1 ? `${label} (${rate > 0 ? "taxed" : "untaxed"} items)` : label,
      quantity: 1,
      unitPrice: part,
      taxRateBps: rate,
    };
  });
}

export type ConversionMode = "full" | "deposit" | "milestones";

/**
 * Plans the draft invoices for a conversion.
 * - full: the itemized one-time lines on one invoice.
 * - deposit: a deposit invoice for `depositPercent` now and the remainder as a second draft.
 * - milestones: one invoice per percentage (must add up to 100).
 * Recurring lines are never invoiced here; they become a recurring schedule.
 */
export function planInvoices(
  lines: ConvertibleLine[],
  e: StoredDiscount,
  mode: ConversionMode,
  opts: { depositPercent?: number | null; milestones?: Array<{ label?: string; percent: number }> },
): InvoicePlan[] {
  const full = invoiceLinesFromEstimate(lines, e);
  if (full.length === 0) return [];
  if (mode === "full") return [{ label: "Full amount", lineItems: full }];

  const total = full.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  if (mode === "deposit") {
    const pct = opts.depositPercent ?? e.depositPercent ?? 0;
    if (pct <= 0 || pct >= 100) throw new Error("Deposit must be between 1 and 99 percent");
    const [deposit, rest] = splitByPercentages(total, [pct, 100 - pct]);
    return [
      { label: `Deposit (${pct}%)`, lineItems: proportionalLines(full, deposit, total, `Deposit (${pct}%)`) },
      { label: `Balance (${100 - pct}%)`, lineItems: proportionalLines(full, rest, total, `Balance (${100 - pct}%)`) },
    ];
  }

  const milestones = opts.milestones ?? [];
  if (milestones.length < 2) throw new Error("Add at least two milestones");
  const parts = splitByPercentages(total, milestones.map((m) => m.percent));
  return milestones.map((m, i) => {
    const label = m.label?.trim() || `Milestone ${i + 1} (${m.percent}%)`;
    return { label, lineItems: proportionalLines(full, parts[i], total, label) };
  });
}
