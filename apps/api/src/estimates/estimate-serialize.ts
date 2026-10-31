import type { Estimate, EstimateLineItem } from "@atrium/database";
import { estimateMargin, estimateTotals, recurringByInterval } from "./estimate-math";

export type EstimateWithLines = Estimate & { lineItems: EstimateLineItem[] };

/** Line fields a client may see; never cost or catalog ids. */
function clientLine(l: EstimateLineItem) {
  return {
    id: l.id,
    group: l.group,
    name: l.name,
    description: l.description,
    unit: l.unit,
    billingType: l.billingType,
    recurringInterval: l.recurringInterval,
    quantity: Number(l.quantity),
    unitPriceCents: l.unitPriceCents,
    taxable: l.taxable,
    taxRateBps: l.taxRateBps,
    optional: l.optional,
    selected: l.selected,
    order: l.order,
  };
}

export function sortLines<T extends { order: number }>(lines: T[]): T[] {
  return [...lines].sort((a, b) => a.order - b.order);
}

/** Full staff view: lines with cost, totals, recurring per interval, and margin. */
export function serializeForStaff<E extends EstimateWithLines>(e: E) {
  const { lineItems, ...rest } = e;
  const lines = sortLines(lineItems);
  return {
    ...rest,
    lineItems: lines.map((l) => ({ ...clientLine(l), catalogItemId: l.catalogItemId, costCents: l.costCents })),
    totals: estimateTotals(lines, e),
    recurring: recurringByInterval(lines),
    margin: estimateMargin(lines, e),
  };
}

/**
 * Client view. Built field by field (an allowlist), so internal columns such
 * as cost, margin, signature storage keys or AI flags can never leak.
 */
export function serializeForClient(e: EstimateWithLines) {
  const lines = sortLines(e.lineItems);
  return {
    id: e.id,
    number: e.number,
    version: e.version,
    status: e.status,
    title: e.title,
    introduction: e.introduction,
    companyId: e.companyId,
    projectId: e.projectId,
    discountType: e.discountType,
    discountValue: e.discountValue,
    depositPercent: e.depositPercent,
    assumptions: e.assumptions,
    exclusions: e.exclusions,
    terms: e.terms,
    validUntil: e.validUntil,
    sentAt: e.sentAt,
    viewedAt: e.viewedAt,
    respondedAt: e.respondedAt,
    acceptedName: e.acceptedName,
    declineReason: e.declineReason,
    createdAt: e.createdAt,
    lineItems: lines.map(clientLine),
    totals: estimateTotals(lines, e),
    recurring: recurringByInterval(lines),
  };
}
