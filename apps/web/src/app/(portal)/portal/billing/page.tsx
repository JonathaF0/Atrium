"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCard, Download, Repeat } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/api";
import { formatCurrency, invoiceTotal } from "@/lib/format";
import { useCurrency } from "@/lib/app-config";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { Pagination } from "@/components/pagination";
import { usePreviewMode } from "@/lib/preview-mode";

interface Plan {
  id: string;
  name: string;
  status: string;
  interval: string;
  intervalCount: number;
  nextRunAt: string | null;
  endDate: string | null;
  companyName: string | null;
  autoCharge: boolean;
  hasCard: boolean;
  items: Array<{ description: string; quantity: number; unitPrice: number; taxRateBps: number }>;
  totals: { subtotalCents: number; taxCents: number; totalCents: number };
}

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  status: string;
  type: string;
  amount?: number | null;
  dueDate?: string | null;
  projectId?: string | null;
  lineItems: Array<{ quantity: number; unitPrice: number }>;
}

const UNIT: Record<string, [string, string]> = {
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  quarterly: ["quarter", "quarters"],
  yearly: ["year", "years"],
};

function every(interval: string, count: number): string {
  const [one, many] = UNIT[interval] ?? [interval, interval];
  return count === 1 ? `per ${one}` : `every ${count} ${many}`;
}

function day(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "";
}

const statusColors: Record<string, { bg: string; text: string }> = {
  sent: { bg: "#dbeafe", text: "#1d4ed8" },
  paid: { bg: "#dcfce7", text: "#15803d" },
  overdue: { bg: "#fee2e2", text: "#b91c1c" },
};

export default function PortalBillingPage() {
  const currency = useCurrency();
  const { success, info, error: showError } = useToast();
  const confirm = useConfirm();
  const { preview } = usePreviewMode();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [paymentsAvailable, setPaymentsAvailable] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadPlans = useCallback(async () => {
    const res = await apiFetch<{ data: Plan[]; paymentsAvailable: boolean }>("/recurring-invoices/mine");
    setPlans(res.data);
    setPaymentsAvailable(res.paymentsAvailable);
  }, []);

  const loadInvoices = useCallback(async () => {
    const res = await apiFetch<PaginatedResponse<InvoiceRow>>(`/invoices/mine?page=${page}&limit=20`);
    setInvoices(res.data);
    setTotalPages(res.meta.totalPages);
  }, [page]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadPlans(), loadInvoices()])
      .catch((err) => showError(err instanceof Error ? err.message : "Failed to load billing"))
      .finally(() => setLoading(false));
  }, [loadPlans, loadInvoices, showError]);

  useEffect(() => {
    apiFetch<{ stripeConnectEnabled: boolean }>("/settings/payment-instructions")
      .then((res) => setStripeEnabled(res.stripeConnectEnabled))
      .catch(() => setStripeEnabled(false));
  }, []);

  // Back from Stripe's card setup page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const card = params.get("card");
    const planId = params.get("plan");
    const sessionId = params.get("session_id");
    if (!card) return;
    window.history.replaceState({}, "", window.location.pathname);
    if (card === "cancelled") {
      info("No card was saved.");
      return;
    }
    if (card === "saved" && planId && sessionId) {
      apiFetch(`/recurring-invoices/mine/${encodeURIComponent(planId)}/card/confirm`, {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      })
        .then(() => {
          success("Card saved. Future invoices for this plan will be charged automatically.");
          return loadPlans();
        })
        .catch((err) => showError(err instanceof Error ? err.message : "Failed to save the card"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveCard = async (plan: Plan): Promise<void> => {
    setBusyId(plan.id);
    try {
      const res = await apiFetch<{ url: string }>(`/recurring-invoices/mine/${plan.id}/card`, { method: "POST" });
      window.location.href = res.url;
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to start card setup");
      setBusyId(null);
    }
  };

  const removeCard = async (plan: Plan): Promise<void> => {
    const ok = await confirm({
      title: "Remove saved card?",
      message: "Future invoices for this plan will need to be paid manually.",
      confirmLabel: "Remove card",
      variant: "danger",
    });
    if (!ok) return;
    setBusyId(plan.id);
    try {
      await apiFetch(`/recurring-invoices/mine/${plan.id}/card`, { method: "DELETE" });
      success("Card removed");
      await loadPlans();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to remove the card");
    } finally {
      setBusyId(null);
    }
  };

  const pay = async (invoice: InvoiceRow): Promise<void> => {
    setBusyId(invoice.id);
    try {
      const here = window.location.href.split("?")[0];
      const res = await apiFetch<{ url: string }>(`/payments/checkout/${invoice.id}`, {
        method: "POST",
        body: JSON.stringify({ successUrl: here, cancelUrl: here }),
      });
      if (res.url) window.location.href = res.url;
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to start payment");
      setBusyId(null);
    }
  };

  const downloadPdf = async (invoice: InvoiceRow): Promise<void> => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/invoices/mine/${invoice.id}/pdf`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${invoice.invoiceNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to download PDF");
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-[var(--muted)] rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Billing</h1>

      <section aria-labelledby="plans-heading" className="space-y-3">
        <h2 id="plans-heading" className="text-lg font-semibold flex items-center gap-2">
          <Repeat size={18} /> Your plans
        </h2>
        {plans.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">You have no recurring plans.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {plans.map((plan) => (
              <div key={plan.id} className="border border-[var(--border)] rounded-lg p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{plan.name}</p>
                    {plan.companyName && <p className="text-xs text-[var(--muted-foreground)]">{plan.companyName}</p>}
                  </div>
                  <p className="text-right">
                    <span className="font-semibold">{formatCurrency(plan.totals.totalCents, currency)}</span>
                    <span className="block text-xs text-[var(--muted-foreground)]">{every(plan.interval, plan.intervalCount)}</span>
                  </p>
                </div>
                <ul className="text-sm text-[var(--muted-foreground)] space-y-0.5">
                  {plan.items.map((item, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">
                        {item.quantity > 1 ? `${item.quantity} x ` : ""}
                        {item.description}
                      </span>
                      <span>{formatCurrency(item.quantity * item.unitPrice, currency)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-[var(--muted-foreground)]">
                  {plan.status === "paused" ? "Paused" : plan.nextRunAt ? `Next invoice ${day(plan.nextRunAt)}` : ""}
                  {plan.endDate ? ` · ends ${day(plan.endDate)}` : ""}
                </p>
                {plan.autoCharge && paymentsAvailable && (
                  <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                    <span className="text-sm flex items-center gap-1.5">
                      <CreditCard size={14} /> {plan.hasCard ? "Card on file, charged automatically" : "No card on file"}
                    </span>
                    {plan.hasCard ? (
                      <button
                        disabled={!!preview || busyId === plan.id}
                        onClick={() => removeCard(plan)}
                        className="text-sm text-[var(--muted-foreground)] hover:underline disabled:opacity-50"
                      >
                        Remove card
                      </button>
                    ) : (
                      <button
                        disabled={!!preview || busyId === plan.id}
                        onClick={() => saveCard(plan)}
                        className="text-sm px-3 py-1.5 bg-[var(--primary)] text-white rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
                      >
                        {busyId === plan.id ? "Redirecting..." : "Save a card"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="invoices-heading" className="space-y-3">
        <h2 id="invoices-heading" className="text-lg font-semibold">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">No invoices yet.</p>
        ) : (
          <div className="space-y-2">
            {invoices.map((inv) => {
              const colors = statusColors[inv.status] ?? { bg: "#e5e7eb", text: "#374151" };
              return (
                <div key={inv.id} className="flex flex-wrap items-center justify-between gap-3 border border-[var(--border)] rounded-lg p-3">
                  <span className="text-sm font-medium">{inv.invoiceNumber}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium">{formatCurrency(invoiceTotal(inv), currency)}</span>
                    {inv.dueDate && <span className="text-xs text-[var(--muted-foreground)]">Due {day(inv.dueDate)}</span>}
                    <span className="text-xs px-2 py-1 rounded-full font-medium capitalize" style={{ backgroundColor: colors.bg, color: colors.text }}>
                      {inv.status}
                    </span>
                    {inv.type !== "uploaded" && (
                      <button onClick={() => downloadPdf(inv)} aria-label={`Download ${inv.invoiceNumber}`} className="text-[var(--primary)]">
                        <Download size={14} />
                      </button>
                    )}
                    {stripeEnabled && ["sent", "overdue"].includes(inv.status) && (
                      <button
                        onClick={() => pay(inv)}
                        disabled={!!preview || busyId === inv.id}
                        className="flex items-center gap-1 text-xs px-3 py-1.5 bg-[var(--primary)] text-white rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
                      >
                        <CreditCard size={12} /> Pay
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </div>
        )}
      </section>
    </div>
  );
}
