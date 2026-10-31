"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { formatTaxRate } from "@/lib/format";

export interface TaxRateOption {
  id: string;
  name: string;
  rateBps: number;
  isDefault: boolean;
}

let cache: Promise<TaxRateOption[]> | null = null;

/** The workspace's active tax rates, fetched once per page load. */
export function useTaxRates(): TaxRateOption[] {
  const [rates, setRates] = useState<TaxRateOption[]>([]);
  useEffect(() => {
    if (!cache) {
      cache = apiFetch<TaxRateOption[]>("/tax-rates").catch(() => {
        cache = null;
        return [];
      });
    }
    let alive = true;
    cache.then((r) => {
      if (alive) setRates(r);
    });
    return () => {
      alive = false;
    };
  }, []);
  return rates;
}

/** Forget the cached list (after tax rates are edited in settings). */
export function invalidateTaxRates(): void {
  cache = null;
}

export function TaxRateSelect({
  value,
  onChange,
  className,
  ariaLabel = "Tax rate",
}: {
  value: number;
  onChange: (rateBps: number) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const rates = useTaxRates();
  // Keep a rate that was archived (or typed elsewhere) selectable so editing doesn't silently drop it.
  const known = value === 0 || rates.some((r) => r.rateBps === value);
  return (
    <select
      aria-label={ariaLabel}
      value={String(value)}
      onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
      className={
        className ??
        "px-2 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm shrink-0"
      }
    >
      <option value="0">No tax</option>
      {rates.map((r) => (
        <option key={r.id} value={String(r.rateBps)}>
          {r.name} ({formatTaxRate(r.rateBps)})
        </option>
      ))}
      {!known && <option value={String(value)}>{formatTaxRate(value)}</option>}
    </select>
  );
}
