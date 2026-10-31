"use client";

import { Markdown } from "@/components/markdown";
import { formatCurrency, formatTaxRate } from "@/lib/format";
import { INTERVAL_LABELS, INTERVAL_SUFFIX } from "@/lib/estimates";

export interface EstimateDocLine {
  id?: string;
  group: string | null;
  name: string;
  description: string | null;
  unit: string;
  billingType: string;
  recurringInterval: string | null;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
  taxRateBps: number;
  optional: boolean;
  selected: boolean;
}

export interface EstimateDocTotals {
  oneTimeSubtotalCents: number;
  recurringSubtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
}

export interface EstimateDocData {
  title: string;
  introduction: string | null;
  discountType: string | null;
  discountValue: number | null;
  depositPercent: number | null;
  assumptions: string | null;
  exclusions: string | null;
  terms: string | null;
  validUntil: string | null;
  lineItems: EstimateDocLine[];
  totals: EstimateDocTotals;
  recurring: Record<string, number>;
}

function qty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2);
}

function LineTable({
  lines,
  currency,
  onToggle,
  toggling,
}: {
  lines: EstimateDocLine[];
  currency: string;
  onToggle?: (line: EstimateDocLine, selected: boolean) => void;
  toggling?: string | null;
}) {
  let group: string | null | undefined;
  return (
    <div className="border border-[var(--border)] rounded-xl overflow-x-auto">
      <table className="w-full text-sm min-w-[480px]">
        <thead>
          <tr className="bg-[var(--muted)] text-left">
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 font-medium text-right">Qty</th>
            <th className="px-3 py-2 font-medium text-right">Price</th>
            <th className="px-3 py-2 font-medium text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const heading = l.group !== group ? l.group : null;
            group = l.group;
            const excluded = l.optional && !l.selected;
            return (
              <FragmentRow key={l.id ?? i} heading={heading}>
                <tr data-testid="estimate-line" className={`border-t border-[var(--border)] ${excluded ? "text-[var(--muted-foreground)]" : ""}`}>
                  <td className="px-3 py-2">
                    <div className="flex items-start gap-2">
                      {l.optional && onToggle && l.id && (
                        <input
                          type="checkbox"
                          aria-label={`Include ${l.name}`}
                          className="mt-1"
                          checked={l.selected}
                          disabled={toggling === l.id}
                          onChange={(e) => onToggle(l, e.target.checked)}
                        />
                      )}
                      <div>
                        <span className="font-medium">{l.name}</span>
                        {l.optional && (
                          <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300">
                            Optional
                          </span>
                        )}
                        {l.description && <p className="text-xs text-[var(--muted-foreground)] whitespace-pre-wrap">{l.description}</p>}
                        {l.taxable && l.taxRateBps > 0 && (
                          <p className="text-xs text-[var(--muted-foreground)]">Tax {formatTaxRate(l.taxRateBps)}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {qty(l.quantity)} <span className="text-xs text-[var(--muted-foreground)]">{l.unit}</span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {formatCurrency(l.unitPriceCents, currency)}
                    {l.billingType === "recurring" && l.recurringInterval && (
                      <span className="text-xs text-[var(--muted-foreground)]"> {INTERVAL_SUFFIX[l.recurringInterval]}</span>
                    )}
                  </td>
                  <td className={`px-3 py-2 text-right whitespace-nowrap ${excluded ? "line-through" : "font-medium"}`}>
                    {formatCurrency(Math.round(l.quantity * l.unitPriceCents), currency)}
                  </td>
                </tr>
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({ heading, children }: { heading: string | null; children: React.ReactNode }) {
  return (
    <>
      {heading && (
        <tr className="border-t border-[var(--border)] bg-[var(--muted)]/40">
          <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            {heading}
          </td>
        </tr>
      )}
      {children}
    </>
  );
}

/** The estimate as the client sees it. Used for the staff preview and the portal. */
export function EstimateDocument({
  estimate,
  currency,
  onToggle,
  toggling,
}: {
  estimate: EstimateDocData;
  currency: string;
  onToggle?: (line: EstimateDocLine, selected: boolean) => void;
  toggling?: string | null;
}) {
  const oneTime = estimate.lineItems.filter((l) => l.billingType !== "recurring");
  const recurring = estimate.lineItems.filter((l) => l.billingType === "recurring");
  const intervals = [...new Set(recurring.map((l) => l.recurringInterval || "monthly"))];
  const t = estimate.totals;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{estimate.title}</h2>
        {estimate.validUntil && (
          <p className="text-xs text-[var(--muted-foreground)] mt-1">Valid until {new Date(estimate.validUntil).toLocaleDateString()}</p>
        )}
      </div>
      {estimate.introduction && <Markdown source={estimate.introduction} />}

      {oneTime.length > 0 && (
        <div className="space-y-3">
          <LineTable lines={oneTime} currency={currency} onToggle={onToggle} toggling={toggling} />
          <dl className="ml-auto max-w-xs text-sm space-y-1" data-testid="estimate-totals">
            <div className="flex justify-between">
              <dt className="text-[var(--muted-foreground)]">Subtotal</dt>
              <dd>{formatCurrency(t.oneTimeSubtotalCents, currency)}</dd>
            </div>
            {t.discountCents > 0 && (
              <div className="flex justify-between">
                <dt className="text-[var(--muted-foreground)]">
                  Discount{estimate.discountType === "percent" && estimate.discountValue ? ` (${formatTaxRate(estimate.discountValue)})` : ""}
                </dt>
                <dd>-{formatCurrency(t.discountCents, currency)}</dd>
              </div>
            )}
            {t.taxCents > 0 && (
              <div className="flex justify-between">
                <dt className="text-[var(--muted-foreground)]">Tax</dt>
                <dd>{formatCurrency(t.taxCents, currency)}</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-[var(--border)] pt-1 font-semibold">
              <dt>Total</dt>
              <dd data-testid="estimate-total">{formatCurrency(t.totalCents, currency)}</dd>
            </div>
            {t.depositCents > 0 && (
              <div className="flex justify-between text-[var(--muted-foreground)]">
                <dt>Deposit due on acceptance ({estimate.depositPercent}%)</dt>
                <dd>{formatCurrency(t.depositCents, currency)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {intervals.map((interval) => (
        <div key={interval} className="space-y-2">
          <h3 className="text-sm font-semibold">Recurring · {INTERVAL_LABELS[interval] ?? interval}</h3>
          <LineTable
            lines={recurring.filter((l) => (l.recurringInterval || "monthly") === interval)}
            currency={currency}
            onToggle={onToggle}
            toggling={toggling}
          />
          <p className="text-sm text-right">
            <span className="text-[var(--muted-foreground)]">{INTERVAL_LABELS[interval] ?? interval} total (before tax): </span>
            <span className="font-semibold">
              {formatCurrency(estimate.recurring[interval] ?? 0, currency)} {INTERVAL_SUFFIX[interval]}
            </span>
          </p>
        </div>
      ))}

      {estimate.assumptions && (
        <section>
          <h3 className="text-sm font-semibold mb-1">Assumptions</h3>
          <Markdown source={estimate.assumptions} />
        </section>
      )}
      {estimate.exclusions && (
        <section>
          <h3 className="text-sm font-semibold mb-1">Exclusions</h3>
          <Markdown source={estimate.exclusions} />
        </section>
      )}
      {estimate.terms && (
        <section>
          <h3 className="text-sm font-semibold mb-1">Terms</h3>
          <Markdown source={estimate.terms} />
        </section>
      )}
    </div>
  );
}
