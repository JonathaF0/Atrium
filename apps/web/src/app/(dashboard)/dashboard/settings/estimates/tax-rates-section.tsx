"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { formatTaxRate } from "@/lib/format";
import { invalidateTaxRates } from "@/components/tax-rate-select";

interface TaxRate {
  id: string;
  name: string;
  rateBps: number;
  isDefault: boolean;
  archivedAt: string | null;
}

const inputClass =
  "px-3 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm outline-none focus:ring-1 focus:ring-[var(--primary)]";

/** "8.25" -> 825 basis points; null when not a valid percentage. */
export function percentToBps(value: string): number | null {
  const n = Number(value.trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

export function TaxRatesSection(): React.ReactElement {
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [rates, setRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [name, setName] = useState<string>("");
  const [percent, setPercent] = useState<string>("");

  const load = useCallback(async (): Promise<void> => {
    try {
      setRates(await apiFetch<TaxRate[]>("/tax-rates?archived=true"));
    } catch (err) {
      console.error(err);
      showError("Failed to load tax rates");
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<unknown>, failure: string): Promise<boolean> {
    try {
      await action();
      invalidateTaxRates();
      await load();
      return true;
    } catch (err) {
      showError(err instanceof Error ? err.message : failure);
      return false;
    }
  }

  async function add(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const rateBps = percentToBps(percent);
    if (!name.trim() || rateBps === null) {
      showError("Enter a name and a rate between 0 and 100");
      return;
    }
    const ok = await run(
      () =>
        apiFetch("/tax-rates", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), rateBps, isDefault: rates.length === 0 }),
        }),
      "Failed to add tax rate",
    );
    if (ok) {
      setName("");
      setPercent("");
      success("Tax rate added");
    }
  }

  async function update(rate: TaxRate, data: Record<string, unknown>, message: string): Promise<void> {
    const ok = await run(
      () => apiFetch(`/tax-rates/${rate.id}`, { method: "PUT", body: JSON.stringify(data) }),
      "Failed to update tax rate",
    );
    if (ok) success(message);
  }

  async function remove(rate: TaxRate): Promise<void> {
    const ok = await confirm({
      title: "Delete tax rate",
      message: `Delete "${rate.name}"? Existing invoices and estimates keep the rate they were created with.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    if (await run(() => apiFetch(`/tax-rates/${rate.id}`, { method: "DELETE" }), "Failed to delete tax rate")) {
      success("Tax rate deleted");
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Tax rates</h2>
        <p className="text-sm text-[var(--muted-foreground)] mt-0.5">
          Rates you can apply to invoice and estimate lines. The default rate is preselected for taxable estimate lines.
        </p>
      </div>
      {!loading && rates.length > 0 && (
        <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl max-w-xl">
          {rates.map((r) => (
            <li key={r.id} data-testid="tax-rate-row" className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span className={r.archivedAt ? "text-[var(--muted-foreground)] line-through" : ""}>
                {r.name} <span className="text-[var(--muted-foreground)]">{formatTaxRate(r.rateBps)}</span>
                {r.isDefault && (
                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-[var(--muted)] text-[var(--muted-foreground)]">Default</span>
                )}
              </span>
              <span className="flex gap-3 text-[var(--muted-foreground)]">
                {!r.isDefault && !r.archivedAt && (
                  <button onClick={() => update(r, { isDefault: true }, "Default tax rate updated")} className="hover:text-[var(--foreground)]">
                    Make default
                  </button>
                )}
                <button
                  onClick={() => update(r, { archived: !r.archivedAt }, r.archivedAt ? "Tax rate restored" : "Tax rate archived")}
                  className="hover:text-[var(--foreground)]"
                >
                  {r.archivedAt ? "Restore" : "Archive"}
                </button>
                <button onClick={() => remove(r)} aria-label={`Delete ${r.name}`} className="hover:text-red-600">
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap gap-2 max-w-xl">
        <input
          aria-label="Tax rate name"
          placeholder="Name, e.g. Sales tax"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          className={`${inputClass} flex-1 min-w-[10rem]`}
        />
        <div className="relative">
          <input
            aria-label="Tax rate percent"
            placeholder="0.00"
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            className={`${inputClass} w-24 pr-7`}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted-foreground)]">%</span>
        </div>
        <button
          type="submit"
          disabled={!name.trim() || !percent.trim()}
          className="px-3 py-1.5 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-40"
        >
          Add rate
        </button>
      </form>
    </div>
  );
}
