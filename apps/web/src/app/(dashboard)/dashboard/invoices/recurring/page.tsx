"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, Pause, Pencil, Play, Plus, Repeat, Square, Trash2, Zap } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { useCurrency } from "@/lib/app-config";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { Pagination } from "@/components/pagination";
import { ScheduleEditor } from "./schedule-editor";
import type { Schedule, ScheduleDetail, ScheduleOptions } from "./types";
import { STATUS_STYLES, formatDay, intervalLabel } from "./types";

function lineTotal(items: Array<{ quantity: number; unitPrice: number; taxRateBps?: number }>): number {
  return items.reduce(
    (sum, i) => sum + i.quantity * i.unitPrice + Math.round((i.quantity * i.unitPrice * (i.taxRateBps ?? 0)) / 10000),
    0,
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_STYLES[status] ?? { bg: "#e5e7eb", text: "#374151" };
  return (
    <span className="text-xs px-2 py-1 rounded-full font-medium capitalize" style={{ backgroundColor: colors.bg, color: colors.text }}>
      {status}
    </span>
  );
}

export default function RecurringInvoicesPage() {
  const currency = useCurrency();
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Schedule[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [options, setOptions] = useState<ScheduleOptions | null>(null);
  const [selected, setSelected] = useState<ScheduleDetail | null>(null);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: "20" });
      if (status) qs.set("status", status);
      const res = await apiFetch<PaginatedResponse<Schedule>>(`/recurring-invoices?${qs.toString()}`);
      setRows(res.data);
      setTotalPages(res.meta.totalPages);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [page, status, showError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiFetch<ScheduleOptions>("/recurring-invoices/options").then(setOptions).catch(console.error);
  }, []);

  const open = useCallback(
    async (id: string) => {
      try {
        setSelected(await apiFetch<ScheduleDetail>(`/recurring-invoices/${id}`));
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to load the schedule");
      }
    },
    [showError],
  );

  const refresh = async (id?: string): Promise<void> => {
    await load();
    if (id) await open(id);
  };

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const runNow = (s: ScheduleDetail) =>
    act(async () => {
      const ok = await confirm({
        title: "Run now?",
        message: `Generate the next invoice for "${s.name}" now${s.autoSend ? " and send it to the client" : " as a draft"}.`,
        confirmLabel: "Generate invoice",
      });
      if (!ok) return;
      const res = await apiFetch<{ invoiceNumber: string }>(`/recurring-invoices/${s.id}/run`, { method: "POST" });
      success(`Invoice ${res.invoiceNumber} generated`);
      await refresh(s.id);
    });

  const setScheduleStatus = (s: ScheduleDetail, next: string) =>
    act(async () => {
      if (next === "ended") {
        const ok = await confirm({
          title: "End schedule?",
          message: "No further invoices will be generated. Existing invoices are kept.",
          confirmLabel: "End schedule",
          variant: "danger",
        });
        if (!ok) return;
      }
      await apiFetch(`/recurring-invoices/${s.id}`, { method: "PUT", body: JSON.stringify({ status: next }) });
      success(next === "paused" ? "Schedule paused" : next === "active" ? "Schedule resumed" : "Schedule ended");
      await refresh(s.id);
    });

  const remove = (s: ScheduleDetail) =>
    act(async () => {
      const ok = await confirm({ title: "Delete schedule?", message: `Delete "${s.name}"?`, confirmLabel: "Delete", variant: "danger" });
      if (!ok) return;
      await apiFetch(`/recurring-invoices/${s.id}`, { method: "DELETE" });
      success("Schedule deleted");
      setSelected(null);
      await load();
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Repeat size={22} /> Recurring billing
          </h1>
          <p className="text-sm text-[var(--muted-foreground)]">Retainers and subscriptions that invoice clients on a schedule.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-sm border border-[var(--border)] rounded-lg bg-[var(--background)]"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="ended">Ended</option>
          </select>
          <button
            onClick={() => setEditing("new")}
            disabled={!options}
            className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={16} /> New schedule
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 space-y-2">
          {loading ? (
            [1, 2, 3].map((i) => <div key={i} className="h-16 bg-[var(--muted)] rounded-lg animate-pulse" />)
          ) : rows.length === 0 ? (
            <div className="border border-dashed border-[var(--border)] rounded-lg p-8 text-center text-sm text-[var(--muted-foreground)]">
              No recurring invoices yet. Create one to bill a retainer every week, month, quarter or year.
            </div>
          ) : (
            rows.map((s) => (
              <button
                key={s.id}
                onClick={() => open(s.id)}
                aria-current={selected?.id === s.id ? "true" : undefined}
                className={`w-full text-left border rounded-lg p-3 hover:bg-[var(--muted)] transition-colors ${
                  selected?.id === s.id ? "border-[var(--primary)]" : "border-[var(--border)]"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.name}</p>
                    <p className="text-xs text-[var(--muted-foreground)] truncate">
                      {[s.company?.name, intervalLabel(s.interval, s.intervalCount), s.status === "active" ? `Next ${formatDay(s.nextRunAt)}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-medium">{formatCurrency(s.totals.totalCents, currency)}</span>
                    <StatusBadge status={s.status} />
                  </div>
                </div>
              </button>
            ))
          )}
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </div>

        <div className="lg:col-span-2">
          {selected ? (
            <section aria-label="Schedule details" className="border border-[var(--border)] rounded-lg p-4 space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{selected.name}</h2>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    {intervalLabel(selected.interval, selected.intervalCount)} · from {formatDay(selected.startDate)}
                    {selected.endDate ? ` to ${formatDay(selected.endDate)}` : ""}
                  </p>
                </div>
                <StatusBadge status={selected.status} />
              </div>

              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-[var(--muted-foreground)]">Bill to</dt>
                <dd>{selected.recipient ? selected.recipient.name : "-"}</dd>
                <dt className="text-[var(--muted-foreground)]">Company</dt>
                <dd>{selected.company?.name ?? "-"}</dd>
                <dt className="text-[var(--muted-foreground)]">Project</dt>
                <dd>{selected.project ? <Link className="text-[var(--primary)] hover:underline" href={`/dashboard/projects/${selected.project.id}?tab=invoices`}>{selected.project.name}</Link> : "-"}</dd>
                <dt className="text-[var(--muted-foreground)]">Per period</dt>
                <dd>{formatCurrency(selected.totals.totalCents, currency)}</dd>
                <dt className="text-[var(--muted-foreground)]">Delivery</dt>
                <dd>{selected.autoSend ? "Sent automatically" : "Created as draft"}</dd>
                <dt className="text-[var(--muted-foreground)]">Card charging</dt>
                <dd>{selected.autoCharge ? (selected.hasCard ? "On, card saved" : "On, waiting for card") : "Off"}</dd>
              </dl>

              <div className="flex flex-wrap gap-2">
                {selected.status === "active" && (
                  <button disabled={busy} onClick={() => runNow(selected)} className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 disabled:opacity-50">
                    <Zap size={14} /> Run now
                  </button>
                )}
                <button disabled={busy || !options} onClick={() => setEditing(selected)} className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--muted)]">
                  <Pencil size={14} /> Edit
                </button>
                {selected.status === "active" && (
                  <button disabled={busy} onClick={() => setScheduleStatus(selected, "paused")} className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--muted)]">
                    <Pause size={14} /> Pause
                  </button>
                )}
                {selected.status !== "active" && (
                  <button disabled={busy} onClick={() => setScheduleStatus(selected, "active")} className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--muted)]">
                    <Play size={14} /> Resume
                  </button>
                )}
                {selected.status !== "ended" && (
                  <button disabled={busy} onClick={() => setScheduleStatus(selected, "ended")} className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--muted)]">
                    <Square size={14} /> End
                  </button>
                )}
                {selected.invoices.length === 0 && (
                  <button disabled={busy} onClick={() => remove(selected)} className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] text-red-600 hover:bg-[var(--muted)]">
                    <Trash2 size={14} /> Delete
                  </button>
                )}
              </div>

              {selected.upcoming.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium mb-2 flex items-center gap-1">
                    <CalendarClock size={14} /> Upcoming runs
                  </h3>
                  <ul className="text-sm space-y-1">
                    {selected.upcoming.map((u) => (
                      <li key={u.runAt} className="flex justify-between">
                        <span>{formatDay(u.runAt)}</span>
                        <span className="text-[var(--muted-foreground)]">
                          {u.factor < 1
                            ? `prorated ${Math.round(u.factor * 100)}%`
                            : formatCurrency(selected.totals.totalCents, currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <h3 className="text-sm font-medium mb-2">Generated invoices</h3>
                {selected.invoices.length === 0 ? (
                  <p className="text-sm text-[var(--muted-foreground)]">None yet.</p>
                ) : (
                  <ul className="text-sm divide-y divide-[var(--border)]">
                    {selected.invoices.map((inv) => (
                      <li key={inv.id} className="flex items-center justify-between py-1.5">
                        <span className="font-medium">{inv.invoiceNumber}</span>
                        <span className="text-[var(--muted-foreground)]">{formatDay(inv.createdAt)}</span>
                        <span>{formatCurrency(lineTotal(inv.lineItems), currency)}</span>
                        <span className="text-xs capitalize">{inv.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ) : (
            <div className="border border-dashed border-[var(--border)] rounded-lg p-6 text-sm text-[var(--muted-foreground)]">
              Select a schedule to see upcoming runs and generated invoices.
            </div>
          )}
        </div>
      </div>

      {editing && options && (
        <ScheduleEditor
          schedule={editing === "new" ? null : editing}
          options={options}
          currency={currency}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            setEditing(null);
            await refresh(saved.id);
          }}
        />
      )}
    </div>
  );
}
