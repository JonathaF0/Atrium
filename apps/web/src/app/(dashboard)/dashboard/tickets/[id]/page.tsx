"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Clock, Lock, Scissors, Star, Trash2 } from "lucide-react";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { LabelPicker } from "@/components/label-picker";
import { LabelBadge } from "@/components/label-badge";
import { Markdown } from "@/components/markdown";
import { formatDuration } from "@/lib/format-duration";
import {
  AttachmentList,
  StatusBadge,
  dueIn,
  formatDateTime,
  priorityLabel,
  statusLabel,
  uploadAttachments,
  type TicketMessage,
} from "@/lib/tickets";

interface TicketEvent {
  id: string;
  type: string;
  fromValue: string | null;
  toValue: string | null;
  detail: string | null;
  actorName: string | null;
  createdAt: string;
}

interface LinkedTicket {
  id: string;
  type: string;
  direction: "in" | "out";
  ticket: { id: string; reference: string; subject: string; status: string };
}

interface TimeRow {
  id: string;
  description: string | null;
  startedAt: string;
  durationSec: number | null;
  billable: boolean;
  invoiceLineItemId: string | null;
  user: { name: string };
}

interface StaffTicket {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  impact: string | null;
  urgency: string | null;
  source: string;
  triage: boolean;
  createdAt: string;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterUserId: string | null;
  assigneeId: string | null;
  categoryId: string | null;
  companyId: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstRespondedAt: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  slaPausedAt: string | null;
  slaPolicy: { id: string; name: string } | null;
  csatRating: number | null;
  csatComment: string | null;
  mergedInto: { id: string; number: number; subject: string } | null;
  mergedFrom: { id: string; number: number; subject: string }[];
  company: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string | null; companyAdmin: boolean } | null;
  project: { id: string; name: string } | null;
  task: { id: string; title: string; projectId: string } | null;
  messages: TicketMessage[];
  events: TicketEvent[];
  labels: { id: string; name: string; color: string }[];
  links: LinkedTicket[];
  timeEntries: TimeRow[];
  timeTotalSec: number;
}

interface Option {
  id: string;
  name: string;
}
interface Staff {
  userId: string;
  name: string;
}
interface Canned {
  id: string;
  title: string;
}

const box = "border border-[var(--border)] rounded-lg p-4";
const input = "w-full px-2 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";

const EVENT_TEXT: Record<string, (e: TicketEvent) => string> = {
  created: (e) => `created the ticket (${e.toValue})`,
  status: (e) => `changed status from ${statusLabel(e.fromValue ?? "")} to ${statusLabel(e.toValue ?? "")}`,
  priority: (e) => `changed priority from ${priorityLabel(e.fromValue ?? "")} to ${priorityLabel(e.toValue ?? "")}`,
  assignee: (e) => (e.toValue ? `assigned to ${e.toValue}` : "unassigned"),
  category: (e) => `set category to ${e.toValue ?? "none"}`,
  company: (e) => `set company to ${e.toValue ?? "none"}`,
  project: (e) => `linked project ${e.toValue ?? "none"}`,
  subject: (e) => `renamed to "${e.toValue}"`,
  label_added: (e) => `added label ${e.toValue}`,
  label_removed: (e) => `removed label ${e.fromValue}`,
  linked: (e) => `linked ${e.toValue}`,
  merged_into: (e) => `merged into ${e.toValue}`,
  merged_from: (e) => `merged ${e.toValue} into this ticket`,
  split_to: (e) => `split a message into ${e.toValue}`,
  split_from: (e) => `split from ${e.toValue}`,
  sla_breach: (e) => `${e.toValue === "first_response" ? "first response" : "resolution"} SLA breached`,
  sla_warning: (e) => `${e.toValue === "first_response" ? "first response" : "resolution"} SLA due soon`,
  triage_accepted: (e) => e.detail ?? "accepted from triage",
  csat: (e) => `rated ${e.toValue}/5`,
  time_logged: (e) => `logged ${e.toValue} (${e.detail})`,
  converted_project: (e) => `created project ${e.toValue}`,
  converted_task: (e) => `created task ${e.toValue}`,
};

export default function StaffTicketPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [ticket, setTicket] = useState<StaffTicket | null>(null);
  const [error, setError] = useState("");
  const [staff, setStaff] = useState<Staff[]>([]);
  const [categories, setCategories] = useState<Option[]>([]);
  const [labels, setLabels] = useState<(Option & { color: string })[]>([]);
  const [canned, setCanned] = useState<Canned[]>([]);

  const load = useCallback(async () => {
    try {
      setTicket(await apiFetch<StaffTicket>(`/tickets/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ticket not found");
    }
  }, [id]);

  useEffect(() => {
    void load();
    apiFetch<Staff[]>("/helpdesk/staff").then(setStaff).catch(() => undefined);
    apiFetch<Option[]>("/helpdesk/categories").then(setCategories).catch(() => undefined);
    apiFetch<(Option & { color: string })[]>("/labels").then(setLabels).catch(() => undefined);
    apiFetch<Canned[]>("/helpdesk/canned-responses").then(setCanned).catch(() => undefined);
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    try {
      await fn();
      if (ok) toast.success(ok);
      await load();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
      return false;
    }
  };

  const patch = (data: Record<string, unknown>): void => {
    void run(() => apiFetch(`/tickets/${id}`, { method: "PATCH", body: JSON.stringify(data) }));
  };

  if (error && !ticket) return <div className="p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>;
  if (!ticket) return <div className="text-sm text-[var(--muted-foreground)]">Loading...</div>;

  const firstDue = !ticket.firstRespondedAt ? dueIn(ticket.firstResponseDueAt) : null;
  const resolutionDue = ticket.status === "resolved" || ticket.status === "closed" ? null : dueIn(ticket.resolutionDueAt);

  return (
    <div className="space-y-4">
      <Link href="/dashboard/tickets" className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
        <ArrowLeft size={14} /> Tickets
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-[var(--muted-foreground)]">
            {ticket.reference} · via {ticket.source} · opened {formatDateTime(ticket.createdAt)}
          </div>
          <h1 className="text-2xl font-bold break-words">{ticket.subject}</h1>
        </div>
        <div className="flex items-center gap-2">
          {ticket.triage && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Triage</span>}
          <StatusBadge status={ticket.status} />
        </div>
      </div>

      {ticket.mergedInto && (
        <div className="p-3 text-sm bg-[var(--muted)] rounded-lg">
          Merged into{" "}
          <Link className="underline" href={`/dashboard/tickets/${ticket.mergedInto.id}`}>
            #{ticket.mergedInto.number} {ticket.mergedInto.subject}
          </Link>
        </div>
      )}
      {ticket.triage && <TriagePanel ticketId={ticket.id} email={ticket.requesterEmail} onDone={load} />}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-4 min-w-0">
          <ol className="space-y-3" aria-label="Conversation">
            {ticket.messages.map((m, i) => (
              <li
                key={m.id}
                data-testid="ticket-message"
                className={`${box} ${m.visibility === "internal" ? "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900" : ""}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-xs text-[var(--muted-foreground)]">
                  <span>
                    <span className="font-medium text-[var(--foreground)]">{m.authorName ?? m.authorEmail ?? "System"}</span>
                    {m.authorEmail && m.authorName && <span> &lt;{m.authorEmail}&gt;</span>}
                    {m.visibility === "internal" && (
                      <span className="ml-2 inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                        <Lock size={11} /> Internal note
                      </span>
                    )}
                    {m.source === "email" && <span className="ml-2">by email</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    {formatDateTime(m.createdAt)}
                    {i > 0 && m.source !== "system" && (
                      <button
                        type="button"
                        title="Split into a new ticket"
                        aria-label="Split into a new ticket"
                        onClick={async () => {
                          if (!(await confirm({ title: "Split message", message: "Move this message into a new ticket?", confirmLabel: "Split" }))) return;
                          try {
                            const created = await apiFetch<{ id: string }>(`/tickets/${id}/split`, { method: "POST", body: JSON.stringify({ messageId: m.id }) });
                            router.push(`/dashboard/tickets/${created.id}`);
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : "Split failed");
                          }
                        }}
                        className="p-1 hover:text-[var(--foreground)]"
                      >
                        <Scissors size={12} />
                      </button>
                    )}
                  </span>
                </div>
                <Markdown source={m.body} />
                <AttachmentList attachments={m.attachments} pathFor={(aid) => `/tickets/attachments/${aid}`} />
              </li>
            ))}
          </ol>

          {!ticket.mergedInto && <Composer ticketId={ticket.id} canned={canned} onSent={load} />}

          <section className={box} aria-label="History">
            <h2 className="font-medium mb-2 text-sm">History</h2>
            <ul className="space-y-1 text-xs text-[var(--muted-foreground)]">
              {ticket.events.map((e) => (
                <li key={e.id}>
                  <span className="mr-2">{formatDateTime(e.createdAt)}</span>
                  <span className="text-[var(--foreground)]">{e.actorName ?? (e.detail?.startsWith("automation") ? "Automation" : "System")}</span>{" "}
                  {(EVENT_TEXT[e.type] ?? ((x: TicketEvent) => x.type))(e)}
                  {e.detail && !["triage_accepted", "time_logged"].includes(e.type) && <span> ({e.detail})</span>}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="space-y-4">
          <section className={`${box} space-y-3`} aria-label="Properties">
            <label className="block text-xs text-[var(--muted-foreground)]">
              Status
              <select aria-label="Status" className={input} value={ticket.status} onChange={(e) => patch({ status: e.target.value })}>
                {TICKET_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
            </label>
            <label className="block text-xs text-[var(--muted-foreground)]">
              Priority
              <select aria-label="Priority" className={input} value={ticket.priority} onChange={(e) => patch({ priority: e.target.value })}>
                {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
              </select>
            </label>
            {ticket.impact && ticket.urgency && (
              <p className="text-xs text-[var(--muted-foreground)]">
                Impact {ticket.impact}, urgency {ticket.urgency}
              </p>
            )}
            <label className="block text-xs text-[var(--muted-foreground)]">
              Category
              <select aria-label="Category" className={input} value={ticket.categoryId ?? ""} onChange={(e) => patch({ categoryId: e.target.value || null })}>
                <option value="">None</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block text-xs text-[var(--muted-foreground)]">
              Assignee
              <select aria-label="Assignee" className={input} value={ticket.assigneeId ?? ""} onChange={(e) => patch({ assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
              </select>
            </label>
            <div className="text-sm">
              <div className="text-xs text-[var(--muted-foreground)]">Requester</div>
              {ticket.contact ? (
                <Link href={`/dashboard/contacts/${ticket.contact.id}`} className="hover:underline">{ticket.contact.name}</Link>
              ) : (
                <span>{ticket.requesterName ?? "—"}</span>
              )}
              {ticket.requesterEmail && <div className="text-xs text-[var(--muted-foreground)] break-all">{ticket.requesterEmail}</div>}
              {!ticket.requesterUserId && !ticket.triage && <div className="text-xs text-[var(--muted-foreground)]">No portal login</div>}
              {ticket.contact && ticket.company && (
                <label className="flex items-center gap-1 text-xs mt-1" title="Company admins see all of their company's tickets in the portal">
                  <input
                    type="checkbox"
                    checked={ticket.contact.companyAdmin}
                    onChange={(e) =>
                      void run(() =>
                        apiFetch(`/helpdesk/contacts/${ticket.contact?.id}/company-admin`, { method: "PUT", body: JSON.stringify({ companyAdmin: e.target.checked }) }),
                      )
                    }
                  />
                  Company admin
                </label>
              )}
            </div>
            {ticket.company && (
              <div className="text-sm">
                <div className="text-xs text-[var(--muted-foreground)]">Company</div>
                <Link href={`/dashboard/contacts/companies/${ticket.company.id}`} className="hover:underline">{ticket.company.name}</Link>
              </div>
            )}
            {ticket.project && (
              <div className="text-sm">
                <div className="text-xs text-[var(--muted-foreground)]">Project</div>
                <Link href={`/dashboard/projects/${ticket.project.id}`} className="hover:underline">{ticket.project.name}</Link>
                {ticket.task && <div className="text-xs">Task: {ticket.task.title}</div>}
              </div>
            )}
          </section>

          <section className={`${box} space-y-2 text-sm`} aria-label="SLA">
            <h2 className="font-medium text-sm flex items-center gap-1"><Clock size={14} /> SLA {ticket.slaPolicy && <span className="font-normal text-xs text-[var(--muted-foreground)]">({ticket.slaPolicy.name})</span>}</h2>
            {!ticket.slaPolicy ? (
              <p className="text-xs text-[var(--muted-foreground)]">No SLA policy applies.</p>
            ) : (
              <>
                {ticket.slaPausedAt && ticket.status !== "resolved" && ticket.status !== "closed" && <p className="text-xs text-amber-700">Clock paused while {statusLabel(ticket.status).toLowerCase()}</p>}
                <div className="flex justify-between gap-2 text-xs">
                  <span>First response</span>
                  {ticket.firstRespondedAt ? (
                    <span className={ticket.firstResponseBreached ? "text-red-600" : "text-green-700"}>{ticket.firstResponseBreached ? "Late" : "Met"} · {formatDateTime(ticket.firstRespondedAt)}</span>
                  ) : ticket.firstResponseBreached ? (
                    <span className="text-red-600 inline-flex items-center gap-1"><AlertTriangle size={11} /> Breached</span>
                  ) : (
                    <span className={firstDue?.overdue ? "text-red-600" : ""}>{firstDue?.text ?? "—"}</span>
                  )}
                </div>
                <div className="flex justify-between gap-2 text-xs">
                  <span>Resolution</span>
                  {ticket.resolutionBreached ? (
                    <span className="text-red-600 inline-flex items-center gap-1"><AlertTriangle size={11} /> Breached</span>
                  ) : (
                    <span className={resolutionDue?.overdue ? "text-red-600" : ""}>{resolutionDue?.text ?? "Done"}</span>
                  )}
                </div>
              </>
            )}
          </section>

          <section className={`${box} space-y-2`} aria-label="Labels">
            <div className="flex items-center justify-between">
              <h2 className="font-medium text-sm">Labels</h2>
              <LabelPicker
                labels={labels}
                assigned={ticket.labels.map((l) => l.id)}
                align="right"
                onToggle={(labelId) => {
                  const has = ticket.labels.some((l) => l.id === labelId);
                  void run(() =>
                    has
                      ? apiFetch(`/tickets/${id}/labels/${labelId}`, { method: "DELETE" })
                      : apiFetch(`/tickets/${id}/labels`, { method: "POST", body: JSON.stringify({ labelId }) }),
                  ).then(() => apiFetch<(Option & { color: string })[]>("/labels").then(setLabels).catch(() => undefined));
                }}
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {ticket.labels.length === 0 && <span className="text-xs text-[var(--muted-foreground)]">None</span>}
              {ticket.labels.map((l) => <LabelBadge key={l.id} name={l.name} color={l.color} />)}
            </div>
          </section>

          <LinksPanel ticket={ticket} run={run} />
          <RelatedPanel ticket={ticket} run={run} />
          <TimePanel ticket={ticket} run={run} />

          {ticket.csatRating && (
            <section className={`${box} text-sm`} aria-label="Satisfaction">
              <h2 className="font-medium text-sm mb-1">Client rating</h2>
              <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} size={16} className={n <= (ticket.csatRating ?? 0) ? "fill-amber-400 text-amber-400" : "text-[var(--muted-foreground)]"} />
                ))}
              </div>
              {ticket.csatComment && <p className="mt-1 text-xs">{ticket.csatComment}</p>}
            </section>
          )}

          <ActionsPanel ticket={ticket} run={run} />

          <button
            type="button"
            onClick={async () => {
              if (!(await confirm({ title: "Delete ticket", message: "Delete this ticket and its attachments? This cannot be undone.", confirmLabel: "Delete", variant: "danger" }))) return;
              try {
                await apiFetch(`/tickets/${id}`, { method: "DELETE" });
                router.push("/dashboard/tickets");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Delete failed");
              }
            }}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
          >
            <Trash2 size={14} /> Delete ticket
          </button>
        </aside>
      </div>
    </div>
  );
}

function Composer({ ticketId, canned, onSent }: { ticketId: string; canned: Canned[]; onSent: () => Promise<void> }): React.ReactElement {
  const toast = useToast();
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"public" | "internal">("public");
  const [status, setStatus] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  const insertCanned = async (cannedId: string): Promise<void> => {
    if (!cannedId) return;
    try {
      const res = await apiFetch<{ body: string }>(`/helpdesk/canned-responses/${cannedId}/render`, { method: "POST", body: JSON.stringify({ ticketId }) });
      setBody((prev) => (prev ? `${prev}\n\n${res.body}` : res.body));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not insert the response");
    }
  };

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      const message = await apiFetch<{ id: string }>(`/tickets/${ticketId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body, visibility, ...(status ? { status } : {}) }),
      });
      if (files.length > 0) {
        const failed = await uploadAttachments(`/tickets/${ticketId}`, message.id, files);
        if (failed.length > 0) toast.error(`Not uploaded: ${failed.join("; ")}`);
      }
      setBody("");
      setFiles([]);
      setFileKey((k) => k + 1);
      setStatus("");
      await onSent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send");
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={send} className={`${box} space-y-2 ${visibility === "internal" ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}`} aria-label="Reply">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex border border-[var(--border)] rounded-lg p-0.5" role="radiogroup" aria-label="Visibility">
          {(["public", "internal"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={visibility === v}
              onClick={() => setVisibility(v)}
              className={`px-3 py-1 text-xs rounded-md ${visibility === v ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
            >
              {v === "public" ? "Public reply" : "Internal note"}
            </button>
          ))}
        </div>
        <ArticlePicker onPick={(md) => setBody((prev) => (prev ? `${prev}\n\n${md}` : md))} />
        {canned.length > 0 && (
          <select aria-label="Insert canned response" className="px-2 py-1 border border-[var(--border)] rounded-lg bg-[var(--background)] text-xs" value="" onChange={(e) => void insertCanned(e.target.value)}>
            <option value="">Insert response...</option>
            {canned.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        )}
      </div>
      <textarea
        aria-label="Message"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        maxLength={50000}
        placeholder={visibility === "public" ? "Reply to the requester (markdown)" : "Note for the team only (markdown)"}
        className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input key={fileKey} type="file" multiple aria-label="Attach files" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))} className="text-xs" />
        <select aria-label="Set status" className="ml-auto px-2 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Keep status</option>
          {TICKET_STATUSES.map((s) => <option key={s} value={s}>{`Set ${statusLabel(s).toLowerCase()}`}</option>)}
        </select>
        <button type="submit" disabled={sending || !body.trim()} className="px-4 py-1.5 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-50">
          {visibility === "public" ? "Send reply" : "Add note"}
        </button>
      </div>
    </form>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;

interface ArticleHit {
  id: string;
  title: string;
  slug: string;
  status?: string;
}

/** Searches published help articles and inserts a markdown link to the portal copy. */
function ArticlePicker({ onPick }: { onPick: (markdown: string) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ArticleHit[]>([]);

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch<ArticleHit[]>(`/kb/search?q=${encodeURIComponent(q.trim())}`)
        .then((rows) => !cancelled && setHits(rows.filter((r) => !r.status || r.status === "published").slice(0, 8)))
        .catch(() => !cancelled && setHits([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, open]);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="px-2 py-1 border border-[var(--border)] rounded-lg text-xs">
        Insert article...
      </button>
    );
  }
  return (
    <div className="relative">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search articles"
        aria-label="Search help articles"
        className="px-2 py-1 border border-[var(--border)] rounded-lg bg-[var(--background)] text-xs w-48"
      />
      {hits.length > 0 && (
        <ul className="absolute z-10 mt-1 w-72 bg-[var(--background)] border border-[var(--border)] rounded-lg shadow-lg text-xs">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(`[${h.title.replace(/[[\]]/g, "")}](${window.location.origin}/portal/kb/${h.slug})`);
                  setOpen(false);
                  setQ("");
                }}
                className="w-full text-left px-3 py-2 hover:bg-[var(--muted)]"
              >
                {h.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface LinkedAsset {
  id: string;
  name: string;
  type: string;
}

interface LinkedAnnouncement {
  id: string;
  title: string;
  type: string;
  status: string;
  incidentState: string | null;
}

/** Assets and incidents linked to the ticket. */
function RelatedPanel({ ticket, run }: { ticket: StaffTicket; run: Run }): React.ReactElement {
  const [assets, setAssets] = useState<LinkedAsset[]>([]);
  const [companyAssets, setCompanyAssets] = useState<LinkedAsset[]>([]);
  const [incidents, setIncidents] = useState<LinkedAnnouncement[]>([]);
  const [activeIncidents, setActiveIncidents] = useState<LinkedAnnouncement[]>([]);
  const [assetId, setAssetId] = useState("");
  const [incidentId, setIncidentId] = useState("");

  const load = useCallback(async (): Promise<void> => {
    const [linkedAssets, linkedIncidents] = await Promise.all([
      apiFetch<LinkedAsset[]>(`/assets/for-ticket/${ticket.id}`).catch(() => []),
      apiFetch<LinkedAnnouncement[]>(`/announcements/for-ticket/${ticket.id}`).catch(() => []),
    ]);
    setAssets(linkedAssets);
    setIncidents(linkedIncidents);
  }, [ticket.id]);

  useEffect(() => {
    void load();
    apiFetch<{ data: LinkedAnnouncement[] }>("/announcements?status=published&type=incident&limit=50")
      .then((r) => setActiveIncidents(r.data.filter((a) => a.incidentState !== "resolved")))
      .catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (!ticket.company) {
      setCompanyAssets([]);
      return;
    }
    apiFetch<{ data: LinkedAsset[] }>(`/assets?companyId=${encodeURIComponent(ticket.company.id)}&limit=100`)
      .then((r) => setCompanyAssets(r.data))
      .catch(() => setCompanyAssets([]));
  }, [ticket.company]);

  const linkAsset = async (): Promise<void> => {
    if (await run(() => apiFetch(`/assets/${assetId}/tickets/${ticket.id}`, { method: "POST" }), "Asset linked")) {
      setAssetId("");
      await load();
    }
  };
  const unlinkAsset = async (id: string): Promise<void> => {
    if (await run(() => apiFetch(`/assets/${id}/tickets/${ticket.id}`, { method: "DELETE" }))) await load();
  };
  const linkIncident = async (): Promise<void> => {
    if (await run(() => apiFetch(`/announcements/${incidentId}/tickets/${ticket.id}`, { method: "POST" }), "Linked to incident")) {
      setIncidentId("");
      await load();
    }
  };
  const unlinkIncident = async (id: string): Promise<void> => {
    if (await run(() => apiFetch(`/announcements/${id}/tickets/${ticket.id}`, { method: "DELETE" }))) await load();
  };

  const linkableAssets = companyAssets.filter((a) => !assets.some((l) => l.id === a.id));
  const linkableIncidents = activeIncidents.filter((a) => !incidents.some((l) => l.id === a.id));

  return (
    <section className={`${box} space-y-3 text-sm`} aria-label="Related">
      <h2 className="font-medium text-sm">Assets and incidents</h2>
      <ul className="space-y-1">
        {assets.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <Link href={`/dashboard/assets?asset=${a.id}`} className="text-[var(--primary)] hover:underline truncate">{a.name}</Link>
            <button type="button" onClick={() => void unlinkAsset(a.id)} className="text-xs text-[var(--muted-foreground)] hover:text-red-600">Remove</button>
          </li>
        ))}
        {incidents.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <Link href={`/dashboard/announcements/${a.id}`} className="text-[var(--primary)] hover:underline truncate">{a.title}</Link>
            <button type="button" onClick={() => void unlinkIncident(a.id)} className="text-xs text-[var(--muted-foreground)] hover:text-red-600">Remove</button>
          </li>
        ))}
        {assets.length === 0 && incidents.length === 0 && <li className="text-xs text-[var(--muted-foreground)]">Nothing linked</li>}
      </ul>
      {linkableAssets.length > 0 && (
        <div className="flex gap-1">
          <select aria-label="Asset to link" value={assetId} onChange={(e) => setAssetId(e.target.value)} className={input}>
            <option value="">Link an asset...</option>
            {linkableAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button type="button" disabled={!assetId} onClick={() => void linkAsset()} className="px-2 py-1 text-xs border border-[var(--border)] rounded-lg">Link</button>
        </div>
      )}
      {linkableIncidents.length > 0 && (
        <div className="flex gap-1">
          <select aria-label="Incident to link" value={incidentId} onChange={(e) => setIncidentId(e.target.value)} className={input}>
            <option value="">Link to an incident...</option>
            {linkableIncidents.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
          <button type="button" disabled={!incidentId} onClick={() => void linkIncident()} className="px-2 py-1 text-xs border border-[var(--border)] rounded-lg">Link</button>
        </div>
      )}
    </section>
  );
}

/** Finds a ticket id from a reference or number the user typed. */
async function findTicketId(ref: string): Promise<{ id: string; reference: string } | null> {
  const res = await apiFetch<{ data: { id: string; reference: string; number: number }[] }>(`/tickets?view=all&limit=5&q=${encodeURIComponent(ref.trim())}`);
  const digits = ref.replace(/\D/g, "");
  return res.data.find((t) => String(t.number) === digits) ?? null;
}

function LinksPanel({ ticket, run }: { ticket: StaffTicket; run: Run }): React.ReactElement {
  const toast = useToast();
  const [ref, setRef] = useState("");
  const add = async (): Promise<void> => {
    const found = await findTicketId(ref);
    if (!found) {
      toast.error("No ticket with that number");
      return;
    }
    if (await run(() => apiFetch(`/tickets/${ticket.id}/links`, { method: "POST", body: JSON.stringify({ relatedTicketId: found.id }) }), "Linked")) setRef("");
  };
  return (
    <section className={`${box} space-y-2`} aria-label="Related tickets">
      <h2 className="font-medium text-sm">Related tickets</h2>
      <ul className="space-y-1 text-xs">
        {ticket.mergedFrom.map((m) => (
          <li key={m.id}>
            Merged: <Link className="hover:underline" href={`/dashboard/tickets/${m.id}`}>#{m.number} {m.subject}</Link>
          </li>
        ))}
        {ticket.links.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-2">
            <span>
              {l.type === "split_from" ? (l.direction === "out" ? "Split from " : "Split into ") : l.type === "duplicate" ? "Duplicate: " : ""}
              <Link className="hover:underline" href={`/dashboard/tickets/${l.ticket.id}`}>{l.ticket.reference} {l.ticket.subject}</Link>
            </span>
            <button type="button" aria-label="Remove link" className="text-[var(--muted-foreground)]" onClick={() => void run(() => apiFetch(`/tickets/${ticket.id}/links/${l.id}`, { method: "DELETE" }))}>×</button>
          </li>
        ))}
      </ul>
      <div className="flex gap-1">
        <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Ticket number" aria-label="Ticket number to link" className={input} />
        <button type="button" disabled={!ref.trim()} onClick={() => void add()} className="px-2 py-1 text-xs border border-[var(--border)] rounded-lg">Link</button>
      </div>
    </section>
  );
}

function TimePanel({ ticket, run }: { ticket: StaffTicket; run: Run }): React.ReactElement {
  const [minutes, setMinutes] = useState("");
  const [description, setDescription] = useState("");
  const [billable, setBillable] = useState(true);
  const log = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const ok = await run(
      () => apiFetch(`/tickets/${ticket.id}/time`, { method: "POST", body: JSON.stringify({ minutes: Number(minutes), description, billable }) }),
      "Time logged",
    );
    if (ok) {
      setMinutes("");
      setDescription("");
    }
  };
  return (
    <section className={`${box} space-y-2`} aria-label="Time">
      <h2 className="font-medium text-sm">Time <span className="font-normal text-xs text-[var(--muted-foreground)]">{formatDuration(ticket.timeTotalSec)}</span></h2>
      <ul className="space-y-1 text-xs">
        {ticket.timeEntries.map((t) => (
          <li key={t.id} className="flex justify-between gap-2">
            <span className="truncate">{t.user.name}: {t.description ?? "—"}</span>
            <span className="shrink-0">{formatDuration(t.durationSec ?? 0)}{t.billable ? "" : " (nb)"}{t.invoiceLineItemId ? " · invoiced" : ""}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={log} className="space-y-1">
        <div className="flex gap-1">
          <input type="number" min={1} max={1440} required value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes" aria-label="Minutes" className={input} />
          <label className="flex items-center gap-1 text-xs whitespace-nowrap">
            <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable
          </label>
        </div>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} placeholder="What was done" aria-label="Time description" className={input} />
        <button type="submit" className="w-full px-2 py-1 text-xs border border-[var(--border)] rounded-lg hover:bg-[var(--muted)]">Log time</button>
      </form>
    </section>
  );
}

function ActionsPanel({ ticket, run }: { ticket: StaffTicket; run: Run }): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [mergeRef, setMergeRef] = useState("");
  const [projects, setProjects] = useState<Option[]>([]);
  const [taskProject, setTaskProject] = useState("");

  useEffect(() => {
    apiFetch<{ data: Option[] }>("/projects?limit=100").then((r) => setProjects(r.data)).catch(() => undefined);
  }, []);

  const merge = async (): Promise<void> => {
    const found = await findTicketId(mergeRef);
    if (!found) {
      toast.error("No ticket with that number");
      return;
    }
    if (await run(() => apiFetch(`/tickets/${ticket.id}/merge`, { method: "POST", body: JSON.stringify({ sourceIds: [found.id] }) }), `Merged ${found.reference} into this ticket`)) setMergeRef("");
  };

  const draftArticle = async (): Promise<void> => {
    try {
      const article = await apiFetch<{ id: string }>(`/kb/articles/from-ticket/${ticket.id}`, { method: "POST" });
      router.push(`/dashboard/kb/articles/${article.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not draft the article");
    }
  };

  return (
    <section className={`${box} space-y-3`} aria-label="Actions">
      <h2 className="font-medium text-sm">Actions</h2>
      <Link
        href={`/dashboard/estimates/new?ticketId=${encodeURIComponent(ticket.id)}`}
        className="block w-full px-2 py-1 text-xs text-center border border-[var(--border)] rounded-lg hover:bg-[var(--muted)]"
      >
        Create estimate
      </Link>
      {(ticket.status === "resolved" || ticket.status === "closed") && (
        <button
          type="button"
          onClick={() => void draftArticle()}
          className="w-full px-2 py-1 text-xs border border-[var(--border)] rounded-lg hover:bg-[var(--muted)]"
        >
          Draft help article from this ticket
        </button>
      )}
      {!ticket.mergedInto && (
        <div>
          <div className="text-xs text-[var(--muted-foreground)] mb-1">Merge another ticket into this one</div>
          <div className="flex gap-1">
            <input value={mergeRef} onChange={(e) => setMergeRef(e.target.value)} placeholder="Ticket number" aria-label="Ticket number to merge" className={input} />
            <button type="button" disabled={!mergeRef.trim()} onClick={() => void merge()} className="px-2 py-1 text-xs border border-[var(--border)] rounded-lg">Merge</button>
          </div>
        </div>
      )}
      {!ticket.project && (
        <button
          type="button"
          onClick={async () => {
            try {
              const p = await apiFetch<{ id: string }>(`/tickets/${ticket.id}/convert/project`, { method: "POST", body: "{}" });
              router.push(`/dashboard/projects/${p.id}`);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Conversion failed");
            }
          }}
          className="w-full px-2 py-1 text-xs border border-[var(--border)] rounded-lg hover:bg-[var(--muted)]"
        >
          Convert to project
        </button>
      )}
      {!ticket.task && projects.length > 0 && (
        <div className="flex gap-1">
          <select aria-label="Project for task" value={taskProject} onChange={(e) => setTaskProject(e.target.value)} className={input}>
            <option value="">Project for a task...</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button
            type="button"
            disabled={!taskProject}
            onClick={() => void run(() => apiFetch(`/tickets/${ticket.id}/convert/task`, { method: "POST", body: JSON.stringify({ projectId: taskProject }) }), "Task created")}
            className="px-2 py-1 text-xs border border-[var(--border)] rounded-lg"
          >
            Create task
          </button>
        </div>
      )}
    </section>
  );
}

function TriagePanel({ ticketId, email, onDone }: { ticketId: string; email: string | null; onDone: () => Promise<void> }): React.ReactElement {
  const toast = useToast();
  const [query, setQuery] = useState(email ?? "");
  const [contacts, setContacts] = useState<{ id: string; name: string; email: string | null }[]>([]);
  const [companies, setCompanies] = useState<Option[]>([]);

  const search = async (): Promise<void> => {
    try {
      const [c, co] = await Promise.all([
        apiFetch<{ data: { id: string; name: string; email: string | null }[] }>(`/contacts?search=${encodeURIComponent(query)}&limit=10`),
        apiFetch<{ data: Option[] }>(`/companies?search=${encodeURIComponent(query)}&limit=10`).catch(() => ({ data: [] as Option[] })),
      ]);
      setContacts(c.data);
      setCompanies(co.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed");
    }
  };

  const accept = async (body: Record<string, string>): Promise<void> => {
    try {
      await apiFetch(`/tickets/${ticketId}/accept`, { method: "POST", body: JSON.stringify(body) });
      toast.success("Ticket accepted");
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not accept");
    }
  };

  return (
    <section className="p-4 border border-amber-300 bg-amber-50 dark:bg-amber-950/30 rounded-lg space-y-2 text-sm" aria-label="Triage">
      <p>This email came from an unknown sender. Accept it by linking a contact or a company; the sender gets no portal access.</p>
      <div className="flex gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find contact or company" className={input} placeholder="Name, email or company" />
        <button type="button" onClick={() => void search()} className="px-3 py-1 border border-[var(--border)] rounded-lg bg-[var(--background)]">Find</button>
      </div>
      <ul className="space-y-1">
        {contacts.map((c) => (
          <li key={c.id} className="flex justify-between gap-2">
            <span>{c.name} {c.email && <span className="text-xs text-[var(--muted-foreground)]">{c.email}</span>}</span>
            <button type="button" onClick={() => void accept({ contactId: c.id })} className="text-xs underline">Accept for contact</button>
          </li>
        ))}
        {companies.map((c) => (
          <li key={c.id} className="flex justify-between gap-2">
            <span>{c.name}</span>
            <button type="button" onClick={() => void accept({ companyId: c.id })} className="text-xs underline">Accept for company</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
