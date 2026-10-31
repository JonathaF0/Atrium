"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/components/toast";
import type { Schedule, ScheduleOptions } from "./types";
import { INTERVAL_OPTIONS } from "./types";

interface ItemDraft {
  description: string;
  quantity: string;
  unitPrice: string; // major units, e.g. "120.00"
  taxPercent: string; // e.g. "8.25"
}

const inputClass =
  "w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)] text-sm";

function toDateInput(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function centsFromInput(value: string): number {
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function bpsFromInput(value: string): number {
  if (!value.trim()) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function ScheduleEditor({
  schedule,
  options,
  currency,
  onClose,
  onSaved,
}: {
  schedule: Schedule | null;
  options: ScheduleOptions;
  currency: string;
  onClose: () => void;
  onSaved: (saved: Schedule) => void;
}) {
  const { error: showError, success } = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(schedule?.name ?? "");
  const [companyId, setCompanyId] = useState(schedule?.companyId ?? "");
  const [recipientUserId, setRecipientUserId] = useState(schedule?.recipientUserId ?? "");
  const [projectId, setProjectId] = useState(schedule?.projectId ?? "");
  const [interval, setIntervalUnit] = useState(schedule?.interval ?? "monthly");
  const [intervalCount, setIntervalCount] = useState(String(schedule?.intervalCount ?? 1));
  const [startDate, setStartDate] = useState(toDateInput(schedule?.startDate) || today());
  const [endDate, setEndDate] = useState(toDateInput(schedule?.endDate));
  const [dueDays, setDueDays] = useState(String(schedule?.dueDays ?? 14));
  const [prorateFirst, setProrateFirst] = useState(schedule?.prorateFirst ?? false);
  const [autoSend, setAutoSend] = useState(schedule?.autoSend ?? true);
  const [autoCharge, setAutoCharge] = useState(schedule?.autoCharge ?? false);
  const [notes, setNotes] = useState(schedule?.notes ?? "");
  const [items, setItems] = useState<ItemDraft[]>(
    schedule?.items.length
      ? schedule.items.map((i) => ({
          description: i.description,
          quantity: String(i.quantity),
          unitPrice: (i.unitPrice / 100).toFixed(2),
          taxPercent: i.taxRateBps ? String(i.taxRateBps / 100) : "",
        }))
      : [{ description: "", quantity: "1", unitPrice: "", taxPercent: "" }],
  );
  const hasRun = !!schedule?.lastRunAt;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const clients = useMemo(
    () => (companyId ? options.clients.filter((c) => c.companyId === companyId) : options.clients),
    [companyId, options.clients],
  );

  const total = items.reduce((sum, i) => {
    const qty = Number(i.quantity) || 0;
    const unit = centsFromInput(i.unitPrice) || 0;
    const bps = bpsFromInput(i.taxPercent) || 0;
    return sum + qty * unit + Math.round((qty * unit * bps) / 10000);
  }, 0);

  const updateItem = (index: number, patch: Partial<ItemDraft>): void => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const parsedItems = items.map((i) => ({
      description: i.description.trim(),
      quantity: Number(i.quantity),
      unitPrice: centsFromInput(i.unitPrice),
      taxRateBps: bpsFromInput(i.taxPercent),
    }));
    if (parsedItems.some((i) => !i.description || !Number.isInteger(i.quantity) || i.quantity < 1 || !Number.isFinite(i.unitPrice) || i.unitPrice < 0 || !Number.isFinite(i.taxRateBps))) {
      showError("Check the line items: each needs a description, a whole quantity and a price.");
      return;
    }
    const body = {
      name: name.trim(),
      companyId: companyId || null,
      recipientUserId: recipientUserId || null,
      projectId: projectId || null,
      interval,
      intervalCount: Number(intervalCount) || 1,
      ...(hasRun ? {} : { startDate }),
      endDate: endDate || null,
      dueDays: Number(dueDays) || 0,
      prorateFirst,
      autoSend,
      autoCharge,
      notes: notes.trim() || null,
      items: parsedItems,
    };
    setSaving(true);
    try {
      const saved = await apiFetch<Schedule>(schedule ? `/recurring-invoices/${schedule.id}` : "/recurring-invoices", {
        method: schedule ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      success(schedule ? "Schedule updated" : "Schedule created");
      onSaved(saved);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save the schedule");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto" onClick={onClose}>
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={schedule ? "Edit schedule" : "New schedule"}
        className="w-full max-w-2xl bg-[var(--background)] border border-[var(--border)] rounded-xl p-6 space-y-5 my-8"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{schedule ? "Edit schedule" : "New recurring invoice"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-[var(--muted)]">
            <X size={18} />
          </button>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Name</span>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required placeholder="Managed services plan" />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Company</span>
            <select
              className={inputClass}
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                setRecipientUserId("");
              }}
            >
              <option value="">No company</option>
              {options.companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Bill to</span>
            <select className={inputClass} value={recipientUserId} onChange={(e) => setRecipientUserId(e.target.value)}>
              <option value="">No portal client</option>
              {clients.map((c) => (
                <option key={c.userId} value={c.userId}>{c.name} ({c.email})</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Project</span>
            <select className={inputClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {options.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Every</span>
            <input className={inputClass} type="number" min={1} max={24} value={intervalCount} onChange={(e) => setIntervalCount(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Interval</span>
            <select className={inputClass} value={interval} onChange={(e) => setIntervalUnit(e.target.value)}>
              {INTERVAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Start date</span>
            <input className={inputClass} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={hasRun} required />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">End date</span>
            <input className={inputClass} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Payment due (days)</span>
            <input className={inputClass} type="number" min={0} max={365} value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={prorateFirst} onChange={(e) => setProrateFirst(e.target.checked)} disabled={hasRun} />
            Prorate first period
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
            Send automatically
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoCharge} onChange={(e) => setAutoCharge(e.target.checked)} disabled={!autoSend} />
            Charge saved card
          </label>
        </div>
        {prorateFirst && (
          <p className="text-xs text-[var(--muted-foreground)]">
            Periods follow the calendar (Mondays, the 1st of the month, quarter or year). A start inside a period bills that
            partial period at a daily rate.
          </p>
        )}
        {autoCharge && (
          <p className="text-xs text-[var(--muted-foreground)]">
            The client saves a card from their portal&apos;s Billing page. Until they do, invoices are sent for manual payment.
          </p>
        )}

        <div className="space-y-2">
          <span className="text-sm font-medium">Line items</span>
          {items.map((item, index) => (
            <div key={index} className="grid grid-cols-12 gap-2 items-center">
              <input
                className={`${inputClass} col-span-12 sm:col-span-5`}
                aria-label={`Item ${index + 1} description`}
                placeholder="Description"
                value={item.description}
                maxLength={500}
                onChange={(e) => updateItem(index, { description: e.target.value })}
              />
              <input
                className={`${inputClass} col-span-3 sm:col-span-2`}
                aria-label={`Item ${index + 1} quantity`}
                type="number"
                min={1}
                value={item.quantity}
                onChange={(e) => updateItem(index, { quantity: e.target.value })}
              />
              <input
                className={`${inputClass} col-span-4 sm:col-span-2`}
                aria-label={`Item ${index + 1} unit price`}
                inputMode="decimal"
                placeholder="0.00"
                value={item.unitPrice}
                onChange={(e) => updateItem(index, { unitPrice: e.target.value })}
              />
              <input
                className={`${inputClass} col-span-3 sm:col-span-2`}
                aria-label={`Item ${index + 1} tax percent`}
                inputMode="decimal"
                placeholder="Tax %"
                value={item.taxPercent}
                onChange={(e) => updateItem(index, { taxPercent: e.target.value })}
              />
              <button
                type="button"
                aria-label={`Remove item ${index + 1}`}
                disabled={items.length === 1}
                onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                className="col-span-2 sm:col-span-1 p-2 rounded hover:bg-[var(--muted)] disabled:opacity-30"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setItems((prev) => [...prev, { description: "", quantity: "1", unitPrice: "", taxPercent: "" }])}
              className="flex items-center gap-1 text-sm text-[var(--primary)] hover:underline"
            >
              <Plus size={14} /> Add item
            </button>
            <span className="text-sm">
              Per period: <span className="font-semibold">{formatCurrency(total, currency)}</span>
            </span>
          </div>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Notes on each invoice</span>
          <textarea className={inputClass} rows={2} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--muted)]">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="px-4 py-2 text-sm rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 disabled:opacity-50">
            {saving ? "Saving..." : "Save schedule"}
          </button>
        </div>
      </form>
    </div>
  );
}
