"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, LifeBuoy, Plus, Search, X } from "lucide-react";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { formatRelativeTime } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { Pagination } from "@/components/pagination";
import { LabelBadge } from "@/components/label-badge";
import { PriorityText, StatusBadge, dueIn, priorityLabel, statusLabel } from "@/lib/tickets";

interface QueueTicket {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  triage: boolean;
  lastActivityAt: string;
  requesterName: string | null;
  requesterEmail: string | null;
  assigneeName: string | null;
  firstRespondedAt: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  slaPausedAt: string | null;
  category: { id: string; name: string; color: string } | null;
  company: { id: string; name: string } | null;
  labels: { id: string; name: string; color: string }[];
}

interface QueueResponse {
  data: QueueTicket[];
  meta: { total: number; totalPages: number };
  counts: Record<string, number>;
}

interface Staff {
  userId: string;
  name: string;
}
interface Option {
  id: string;
  name: string;
}

const VIEWS = [
  { id: "open", label: "Open" },
  { id: "unassigned", label: "Unassigned" },
  { id: "mine", label: "Mine" },
  { id: "triage", label: "Triage" },
  { id: "sla_risk", label: "SLA risk" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

const selectClass = "px-2 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";

function SlaCell({ t }: { t: QueueTicket }): React.ReactElement {
  if (t.firstResponseBreached || t.resolutionBreached) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-600">
        <AlertTriangle size={12} /> Breached
      </span>
    );
  }
  if (t.slaPausedAt || t.status === "resolved" || t.status === "closed") return <span className="text-xs text-[var(--muted-foreground)]">—</span>;
  const due = dueIn(!t.firstRespondedAt ? t.firstResponseDueAt : t.resolutionDueAt);
  if (!due) return <span className="text-xs text-[var(--muted-foreground)]">—</span>;
  return <span className={`text-xs ${due.overdue ? "text-red-600" : "text-[var(--muted-foreground)]"}`}>{due.text}</span>;
}

export default function TicketsQueuePage(): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();
  const [view, setView] = useState(searchParams.get("view") ?? "open");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [labelId, setLabelId] = useState("");
  const [search, setSearch] = useState("");
  const q = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [staff, setStaff] = useState<Staff[]>([]);
  const [categories, setCategories] = useState<Option[]>([]);
  const [labels, setLabels] = useState<(Option & { color: string })[]>([]);
  const [showNew, setShowNew] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    apiFetch<Staff[]>("/helpdesk/staff").then(setStaff).catch(() => undefined);
    apiFetch<Option[]>("/helpdesk/categories").then(setCategories).catch(() => undefined);
    apiFetch<(Option & { color: string })[]>("/labels").then(setLabels).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ view, page: String(page), limit: "25" });
      if (status) params.set("status", status);
      if (priority) params.set("priority", priority);
      if (categoryId) params.set("categoryId", categoryId);
      if (assigneeId) params.set("assigneeId", assigneeId);
      if (labelId) params.set("labelId", labelId);
      if (q) params.set("q", q);
      const res = await apiFetch<QueueResponse>(`/tickets?${params}`);
      if (mine !== requestId.current) return;
      setResult(res);
      setSelected(new Set());
    } catch (err) {
      if (mine === requestId.current) toast.error(err instanceof Error ? err.message : "Failed to load tickets");
    } finally {
      if (mine === requestId.current) setLoading(false);
    }
  }, [view, page, status, priority, categoryId, assigneeId, labelId, q, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeView = (v: string): void => {
    setView(v);
    setPage(1);
    router.replace(`/dashboard/tickets?view=${v}`);
  };

  const bulk = async (action: string, value?: string): Promise<void> => {
    if (selected.size === 0) return;
    if (action === "close" && !(await confirm({ title: "Close tickets", message: `Close ${selected.size} ticket(s)? Requesters are notified.`, confirmLabel: "Close" }))) return;
    try {
      const res = await apiFetch<{ updated: number }>("/tickets/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], action, ...(value !== undefined ? { value } : {}) }),
      });
      toast.success(`Updated ${res.updated} ticket(s)`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk action failed");
    }
  };

  const tickets = result?.data ?? [];
  const allSelected = tickets.length > 0 && tickets.every((t) => selected.has(t.id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Tickets</h1>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium hover:opacity-90"
        >
          <Plus size={16} /> New ticket
        </button>
      </div>

      <nav aria-label="Ticket views" className="flex gap-1 border-b border-[var(--border)] overflow-x-auto">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            aria-current={view === v.id ? "page" : undefined}
            onClick={() => changeView(v.id)}
            className={`px-3 py-2 text-sm whitespace-nowrap relative ${view === v.id ? "font-medium text-[var(--foreground)]" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
          >
            {v.label}
            {result?.counts?.[v.id] !== undefined && <span className="ml-1 text-xs text-[var(--muted-foreground)]">{result.counts[v.id]}</span>}
            {view === v.id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--primary)]" />}
          </button>
        ))}
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Subject or number..."
            maxLength={200}
            className="w-full pl-9 pr-3 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
          />
        </div>
        <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className={selectClass}>
          <option value="">Any status</option>
          {TICKET_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
        <select aria-label="Priority" value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }} className={selectClass}>
          <option value="">Any priority</option>
          {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
        </select>
        <select aria-label="Category" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(1); }} className={selectClass}>
          <option value="">Any category</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select aria-label="Assignee" value={assigneeId} onChange={(e) => { setAssigneeId(e.target.value); setPage(1); }} className={selectClass}>
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
        </select>
        {labels.length > 0 && (
          <select aria-label="Label" value={labelId} onChange={(e) => { setLabelId(e.target.value); setPage(1); }} className={selectClass}>
            <option value="">Any label</option>
            {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-2 bg-[var(--muted)] rounded-lg text-sm" role="toolbar" aria-label="Bulk actions">
          <span className="font-medium">{selected.size} selected</span>
          <select aria-label="Assign selected" className={selectClass} value="" onChange={(e) => e.target.value && void bulk("assign", e.target.value)}>
            <option value="">Assign...</option>
            <option value="none">Unassign</option>
            {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
          </select>
          <select aria-label="Set status of selected" className={selectClass} value="" onChange={(e) => e.target.value && void bulk("status", e.target.value)}>
            <option value="">Status...</option>
            {TICKET_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          <select aria-label="Set priority of selected" className={selectClass} value="" onChange={(e) => e.target.value && void bulk("priority", e.target.value)}>
            <option value="">Priority...</option>
            {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
          </select>
          {labels.length > 0 && (
            <select aria-label="Label selected" className={selectClass} value="" onChange={(e) => e.target.value && void bulk("add_label", e.target.value)}>
              <option value="">Add label...</option>
              {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          <button type="button" onClick={() => void bulk("close")} className="px-3 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] hover:bg-[var(--muted)]">
            Close selected
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto p-1" aria-label="Clear selection">
            <X size={16} />
          </button>
        </div>
      )}

      <div className="border border-[var(--border)] rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]">
            <tr>
              <th className="p-2 w-8">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(tickets.map((t) => t.id)))}
                />
              </th>
              <th className="p-2">Ticket</th>
              <th className="p-2">Requester</th>
              <th className="p-2">Status</th>
              <th className="p-2">Priority</th>
              <th className="p-2">Assignee</th>
              <th className="p-2">SLA</th>
              <th className="p-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id} className="border-t border-[var(--border)] hover:bg-[var(--muted)]/50" data-testid="ticket-row">
                <td className="p-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${t.reference}`}
                    checked={selected.has(t.id)}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(t.id)) next.delete(t.id);
                      else next.add(t.id);
                      setSelected(next);
                    }}
                  />
                </td>
                <td className="p-2 min-w-[220px]">
                  <Link href={`/dashboard/tickets/${t.id}`} className="font-medium hover:underline">
                    <span className="text-[var(--muted-foreground)] font-normal mr-1">{t.reference}</span>
                    {t.subject}
                  </Link>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {t.triage && <span className="text-[10px] px-1.5 rounded-full bg-amber-100 text-amber-800">Triage</span>}
                    {t.category && <span className="text-[10px] text-[var(--muted-foreground)]">{t.category.name}</span>}
                    {t.labels.map((l) => <LabelBadge key={l.id} name={l.name} color={l.color} />)}
                  </div>
                </td>
                <td className="p-2">
                  <div>{t.requesterName ?? t.requesterEmail ?? "—"}</div>
                  {t.company && <div className="text-xs text-[var(--muted-foreground)]">{t.company.name}</div>}
                </td>
                <td className="p-2"><StatusBadge status={t.status} /></td>
                <td className="p-2"><PriorityText priority={t.priority} /></td>
                <td className="p-2 text-xs">{t.assigneeName ?? <span className="text-[var(--muted-foreground)]">Unassigned</span>}</td>
                <td className="p-2"><SlaCell t={t} /></td>
                <td className="p-2 text-xs text-[var(--muted-foreground)] whitespace-nowrap">{formatRelativeTime(t.lastActivityAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && tickets.length === 0 && (
          <div className="text-center py-12 text-[var(--muted-foreground)]">
            <LifeBuoy size={36} className="mx-auto mb-2 opacity-40" />
            No tickets in this view.
          </div>
        )}
        {loading && tickets.length === 0 && <div className="p-6 text-sm text-[var(--muted-foreground)]">Loading...</div>}
      </div>

      <Pagination page={page} totalPages={result?.meta.totalPages ?? 1} onPageChange={setPage} />

      {showNew && (
        <NewTicketModal
          staff={staff}
          categories={categories}
          onClose={() => setShowNew(false)}
          onCreated={(id) => router.push(`/dashboard/tickets/${id}`)}
        />
      )}
    </div>
  );
}

function NewTicketModal({
  staff,
  categories,
  onClose,
  onCreated,
}: {
  staff: Staff[];
  categories: Option[];
  onClose: () => void;
  onCreated: (id: string) => void;
}): React.ReactElement {
  const [form, setForm] = useState({ requesterEmail: "", requesterName: "", subject: "", description: "", categoryId: "", priority: "normal", assigneeId: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const input = "w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body: Record<string, string> = { subject: form.subject, description: form.description, requesterEmail: form.requesterEmail.trim(), priority: form.priority };
      if (form.requesterName.trim()) body.requesterName = form.requesterName.trim();
      if (form.categoryId) body.categoryId = form.categoryId;
      if (form.assigneeId) body.assigneeId = form.assigneeId;
      const t = await apiFetch<{ id: string }>("/tickets", { method: "POST", body: JSON.stringify(body) });
      onCreated(t.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the ticket");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="New ticket">
      <form onSubmit={submit} className="w-full max-w-lg bg-[var(--background)] rounded-xl p-6 space-y-3 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold">New ticket</h2>
        {error && <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm">
            Requester email
            <input type="email" required value={form.requesterEmail} onChange={set("requesterEmail")} maxLength={320} className={input} />
          </label>
          <label className="text-sm">
            Requester name
            <input value={form.requesterName} onChange={set("requesterName")} maxLength={200} className={input} />
          </label>
        </div>
        <label className="block text-sm">
          Subject
          <input required value={form.subject} onChange={set("subject")} maxLength={200} className={input} />
        </label>
        <label className="block text-sm">
          Description
          <textarea required rows={5} value={form.description} onChange={set("description")} maxLength={50000} className={input} />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="text-sm">
            Category
            <select value={form.categoryId} onChange={set("categoryId")} className={input}>
              <option value="">None</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="text-sm">
            Priority
            <select value={form.priority} onChange={set("priority")} className={input}>
              {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
            </select>
          </label>
          <label className="text-sm">
            Assignee
            <select value={form.assigneeId} onChange={set("assigneeId")} className={input}>
              <option value="">Unassigned</option>
              {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-50">
            {saving ? "Creating..." : "Create ticket"}
          </button>
        </div>
      </form>
    </div>
  );
}
