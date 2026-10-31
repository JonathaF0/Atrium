"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Copy, Download, GitBranch, Send, Trash2, Wand2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useCurrency } from "@/lib/app-config";
import { formatCurrency } from "@/lib/format";
import { downloadCsv } from "@/lib/download";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { EstimateDocument } from "@/components/estimate-document";
import { EstimateStatusBadge } from "@/components/estimate-status-badge";
import { centsToInput } from "@/lib/estimates";
import { EstimateBuilder, newKey, type BuilderForm } from "../estimate-builder";
import { ConvertDialog } from "./convert-dialog";

interface DetailLine {
  id: string;
  catalogItemId: string | null;
  group: string | null;
  name: string;
  description: string | null;
  unit: string;
  billingType: string;
  recurringInterval: string | null;
  quantity: number;
  unitPriceCents: number;
  costCents: number | null;
  taxable: boolean;
  taxRateBps: number;
  optional: boolean;
  selected: boolean;
}

interface EstimateDetail {
  id: string;
  number: string;
  version: number;
  status: string;
  title: string;
  introduction: string | null;
  companyId: string | null;
  recipientUserId: string | null;
  projectId: string | null;
  ticketId: string | null;
  discountType: string | null;
  discountValue: number | null;
  depositPercent: number | null;
  assumptions: string | null;
  exclusions: string | null;
  terms: string | null;
  validUntil: string | null;
  sentAt: string | null;
  acceptedName: string | null;
  declineReason: string | null;
  aiDrafted: boolean;
  documentId: string | null;
  company: { id: string; name: string } | null;
  recipient: { id: string; name: string | null } | null;
  project: { id: string; name: string } | null;
  ticket: { id: string; number: number; subject: string } | null;
  lineItems: DetailLine[];
  totals: {
    oneTimeSubtotalCents: number;
    recurringSubtotalCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
    depositCents: number;
  };
  recurring: Record<string, number>;
  margin: { priceCents: number; costCents: number; marginCents: number; marginPercent: number | null; missingCost: number };
  versions: Array<{ id: string; version: number; status: string }>;
  invoices: Array<{ id: string; invoiceNumber: string; status: string; projectId: string | null }>;
  events: Array<{ id: string; action: string; detail: string | null; actorName: string | null; ipAddress: string | null; createdAt: string }>;
  comments: Array<{ id: string; content: string; authorName: string | null; createdAt: string }>;
}

const EVENT_LABELS: Record<string, string> = {
  created: "Created",
  sent: "Sent",
  viewed: "Viewed by client",
  option_toggled: "Client changed an option",
  changes_requested: "Client requested changes",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  revised: "Revised",
  converted: "Converted",
  reminder_sent: "Expiry reminder sent",
};

function dateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toForm(e: EstimateDetail): BuilderForm {
  return {
    title: e.title,
    introduction: e.introduction ?? "",
    companyId: e.companyId ?? "",
    recipientUserId: e.recipientUserId ?? "",
    projectId: e.projectId ?? "",
    ticketId: e.ticketId ?? "",
    discountType: e.discountType ?? "",
    discountValue:
      e.discountType === "percent" && e.discountValue != null
        ? String(e.discountValue / 100)
        : e.discountType === "amount"
          ? centsToInput(e.discountValue)
          : "",
    depositPercent: e.depositPercent ? String(e.depositPercent) : "",
    assumptions: e.assumptions ?? "",
    exclusions: e.exclusions ?? "",
    terms: e.terms ?? "",
    validUntil: dateInput(e.validUntil),
    aiDrafted: e.aiDrafted,
    lines: e.lineItems.map((l) => ({
      key: newKey(),
      catalogItemId: l.catalogItemId,
      group: l.group ?? "",
      name: l.name,
      description: l.description ?? "",
      unit: l.unit,
      billingType: l.billingType,
      recurringInterval: l.recurringInterval ?? "monthly",
      quantity: String(l.quantity),
      unitPrice: centsToInput(l.unitPriceCents),
      costCents: l.costCents,
      taxable: l.taxable,
      taxRateBps: l.taxRateBps,
      optional: l.optional,
      selected: l.selected,
    })),
  };
}

export default function EstimateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const currency = useCurrency();
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [estimate, setEstimate] = useState<EstimateDetail | null>(null);
  const [defaultTax, setDefaultTax] = useState(0);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [converting, setConverting] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const e = await apiFetch<EstimateDetail>(`/estimates/${id}`);
      setEstimate(e);
      setVersion((v) => v + 1);
    } catch {
      setNotFound(true);
    }
  }, [id]);

  useEffect(() => {
    load();
    apiFetch<{ defaultTaxRateBps: number }>("/estimates/settings")
      .then((s) => setDefaultTax(s.defaultTaxRateBps))
      .catch(() => undefined);
  }, [load]);

  async function act(path: string, message: string, navigate = false): Promise<void> {
    setBusy(true);
    try {
      const res = await apiFetch<{ id: string }>(`/estimates/${id}/${path}`, { method: "POST" });
      success(message);
      if (navigate && res.id !== id) router.push(`/dashboard/estimates/${res.id}`);
      else await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    const ok = await confirm({
      title: "Send estimate",
      message: `Send ${estimate?.number} to ${estimate?.recipient?.name ?? "the client"}? They'll get an email and can respond in the portal.`,
      confirmLabel: "Send",
    });
    if (ok) await act("send", "Estimate sent");
  }

  async function remove(): Promise<void> {
    const ok = await confirm({ title: "Delete draft", message: "Delete this draft estimate?", confirmLabel: "Delete", variant: "danger" });
    if (!ok) return;
    try {
      await apiFetch(`/estimates/${id}`, { method: "DELETE" });
      success("Draft deleted");
      router.push("/dashboard/estimates");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function postComment(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!comment.trim()) return;
    try {
      await apiFetch(`/estimates/${id}/comments`, { method: "POST", body: JSON.stringify({ content: comment.trim() }) });
      setComment("");
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to comment");
    }
  }

  if (notFound) return <p className="text-sm text-[var(--muted-foreground)]">Estimate not found.</p>;
  if (!estimate) return <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>;

  const e = estimate;
  const isDraft = e.status === "draft";
  const canSend = isDraft || e.status === "changes_requested";
  const canRevise = ["sent", "viewed", "changes_requested", "declined", "expired"].includes(e.status);
  const latest = e.versions.length === 0 || e.versions[e.versions.length - 1].id === e.id;
  const btn = "flex items-center gap-1.5 px-3 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)] disabled:opacity-50";

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/estimates" className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
          <ArrowLeft size={14} /> Estimates
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">
              {e.number}
              {e.version > 1 && <span className="text-[var(--muted-foreground)] font-normal"> v{e.version}</span>}
            </h1>
            <EstimateStatusBadge status={e.status} />
          </div>
          <div className="flex flex-wrap gap-2">
            {canSend && (
              <button onClick={send} disabled={busy} className="flex items-center gap-1.5 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium disabled:opacity-50">
                <Send size={14} /> {isDraft ? "Send" : "Send again"}
              </button>
            )}
            {canRevise && latest && (
              <button onClick={() => act("revise", "New version drafted", true)} disabled={busy} className={btn}>
                <GitBranch size={14} /> Revise
              </button>
            )}
            {e.status === "accepted" && (
              <button onClick={() => setConverting(true)} className="flex items-center gap-1.5 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium">
                <Wand2 size={14} /> Convert
              </button>
            )}
            <button onClick={() => act("duplicate", "Estimate duplicated", true)} disabled={busy} className={btn}>
              <Copy size={14} /> Duplicate
            </button>
            <button onClick={() => downloadCsv(`/estimates/${id}/pdf`).catch(() => showError("Download failed"))} className={btn}>
              <Download size={14} /> PDF
            </button>
            {isDraft && (
              <button onClick={remove} className={`${btn} text-red-600`}>
                <Trash2 size={14} /> Delete
              </button>
            )}
          </div>
        </div>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          {[e.company?.name, e.recipient?.name].filter(Boolean).join(" · ") || "No client yet"}
          {e.project && (
            <>
              {" · "}
              <Link href={`/dashboard/projects/${e.project.id}`} className="hover:underline">{e.project.name}</Link>
            </>
          )}
          {e.ticket && <> · Ticket #{e.ticket.number}</>}
          {e.aiDrafted && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-[var(--muted)]">AI-assisted draft</span>}
        </p>
      </div>

      {e.status === "changes_requested" && (
        <div className="p-3 rounded-lg bg-amber-500/10 text-sm">
          The client asked for changes. Read their comment below, then revise the estimate or send it again.
        </div>
      )}
      {e.status === "declined" && e.declineReason && (
        <div className="p-3 rounded-lg bg-rose-500/10 text-sm">Declined: {e.declineReason}</div>
      )}
      {(e.status === "accepted" || e.status === "converted") && e.acceptedName && (
        <div className="p-3 rounded-lg bg-emerald-500/10 text-sm">Accepted and signed by {e.acceptedName}.</div>
      )}
      {e.status === "converted" && (
        <div className="p-3 rounded-lg border border-[var(--border)] text-sm space-y-1" data-testid="conversion-summary">
          <p className="font-medium">Converted</p>
          {e.project && (
            <p>
              Project: <Link href={`/dashboard/projects/${e.project.id}`} className="text-[var(--primary)] hover:underline">{e.project.name}</Link>
            </p>
          )}
          {e.invoices.length > 0 && (
            <p>
              Draft invoices:{" "}
              {e.invoices.map((inv, i) => (
                <span key={inv.id}>
                  {i > 0 && ", "}
                  {inv.projectId ? (
                    <Link href={`/dashboard/projects/${inv.projectId}?tab=invoices`} className="text-[var(--primary)] hover:underline">{inv.invoiceNumber}</Link>
                  ) : (
                    inv.invoiceNumber
                  )}
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {isDraft ? (
        <EstimateBuilder key={version} initial={toForm(e)} estimateId={e.id} defaultTax={defaultTax} onSaved={load} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
          <div className="border border-[var(--border)] rounded-xl p-5 min-w-0">
            <EstimateDocument estimate={e} currency={currency} />
          </div>
          <aside className="space-y-4">
            <div className="border border-[var(--border)] rounded-xl p-4 text-sm space-y-1" data-testid="margin-panel">
              <p className="font-medium mb-1">Margin (internal)</p>
              <div className="flex justify-between"><span className="text-[var(--muted-foreground)]">Price</span><span>{formatCurrency(e.margin.priceCents, currency)}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted-foreground)]">Cost</span><span>{formatCurrency(e.margin.costCents, currency)}</span></div>
              <div className="flex justify-between font-medium">
                <span>Margin</span>
                <span>
                  {formatCurrency(e.margin.marginCents, currency)}
                  {e.margin.marginPercent != null && ` (${e.margin.marginPercent}%)`}
                </span>
              </div>
              {e.margin.missingCost > 0 && (
                <p className="text-xs text-[var(--muted-foreground)]">{e.margin.missingCost} line(s) have no cost set.</p>
              )}
            </div>
          </aside>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Comments</h2>
          <ul className="space-y-2" data-testid="estimate-comments">
            {e.comments.length === 0 && <li className="text-sm text-[var(--muted-foreground)]">No comments yet.</li>}
            {e.comments.map((c) => (
              <li key={c.id} className="border border-[var(--border)] rounded-lg p-3 text-sm">
                <p className="text-xs text-[var(--muted-foreground)] mb-1">
                  {c.authorName ?? "Someone"} · {new Date(c.createdAt).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap">{c.content}</p>
              </li>
            ))}
          </ul>
          <form onSubmit={postComment} className="flex gap-2">
            <input
              aria-label="Comment"
              value={comment}
              maxLength={5000}
              onChange={(ev) => setComment(ev.target.value)}
              placeholder="Reply to the client..."
              className="flex-1 px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
            />
            <button type="submit" disabled={!comment.trim()} className="px-3 py-2 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-40">
              Post
            </button>
          </form>
        </section>
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">History</h2>
          {e.versions.length > 1 && (
            <div className="flex flex-wrap gap-2 text-xs">
              {e.versions.map((v) => (
                <Link
                  key={v.id}
                  href={`/dashboard/estimates/${v.id}`}
                  className={`px-2 py-1 rounded border border-[var(--border)] ${v.id === e.id ? "bg-[var(--muted)] font-medium" : "hover:bg-[var(--muted)]"}`}
                >
                  v{v.version} · {v.status.replace("_", " ")}
                </Link>
              ))}
            </div>
          )}
          <ol className="relative border-l border-[var(--border)] ml-2 space-y-3" data-testid="estimate-history">
            {e.events.map((ev) => (
              <li key={ev.id} className="ml-4 text-sm">
                <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-[var(--border)]" />
                <p>
                  <span className="font-medium">{EVENT_LABELS[ev.action] ?? ev.action}</span>
                  {ev.actorName && <span className="text-[var(--muted-foreground)]"> by {ev.actorName}</span>}
                </p>
                {ev.detail && <p className="text-xs text-[var(--muted-foreground)]">{ev.detail}</p>}
                <p className="text-xs text-[var(--muted-foreground)]">
                  {new Date(ev.createdAt).toLocaleString()}
                  {ev.ipAddress && ` · ${ev.ipAddress}`}
                </p>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {converting && (
        <ConvertDialog
          estimate={e}
          onClose={() => setConverting(false)}
          onDone={async () => {
            setConverting(false);
            await load();
          }}
        />
      )}
    </div>
  );
}
