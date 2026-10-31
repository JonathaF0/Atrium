"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Link2, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { Skeleton } from "@/components/skeletons";
import { AnnouncementTimeline } from "@/components/announcement-timeline";
import { Markdown } from "@/components/markdown";
import {
  INCIDENT_STATE_LABELS,
  STATUS_LABELS,
  formatDateTime,
} from "@/lib/announcements";
import {
  AnnouncementEditor,
  fromLocalInput,
  inputClass,
  type AnnouncementDetail,
} from "../announcement-editor";

interface LinkedTicket {
  id: string;
  reference: string;
  subject: string;
  status: string;
}

const buttonClass = "px-3 py-1.5 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)] disabled:opacity-50";

function UpdateForm({ announcement, onPosted }: { announcement: AnnouncementDetail; onPosted: (a: AnnouncementDetail) => void }): React.ReactElement {
  const toast = useToast();
  const isIncident = announcement.type === "incident";
  const [body, setBody] = useState("");
  const [state, setState] = useState(announcement.incidentState ?? "investigating");
  const [postmortem, setPostmortem] = useState("");
  const [notify, setNotify] = useState(true);
  const [posting, setPosting] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    try {
      const payload: Record<string, unknown> = { body, notify };
      if (isIncident) payload.state = state;
      if (isIncident && state === "resolved" && postmortem.trim()) payload.postmortem = postmortem;
      const updated = await apiFetch<AnnouncementDetail>(`/announcements/${announcement.id}/updates`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setBody("");
      setPostmortem("");
      onPosted(updated);
      toast.success("Update posted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not post update");
    } finally {
      setPosting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Post update">
      {isIncident && (
        <div>
          <label htmlFor="update-state" className="block text-sm font-medium mb-1">
            Status
          </label>
          <select id="update-state" value={state} onChange={(e) => setState(e.target.value)} className={inputClass}>
            {Object.entries(INCIDENT_STATE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label htmlFor="update-body" className="block text-sm font-medium mb-1">
          Update
        </label>
        <textarea
          id="update-body"
          rows={3}
          maxLength={20000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={inputClass}
        />
      </div>
      {isIncident && state === "resolved" && (
        <div>
          <label htmlFor="update-postmortem" className="block text-sm font-medium mb-1">
            Postmortem summary <span className="font-normal text-[var(--muted-foreground)]">(optional, Markdown)</span>
          </label>
          <textarea
            id="update-postmortem"
            rows={4}
            maxLength={20000}
            value={postmortem}
            onChange={(e) => setPostmortem(e.target.value)}
            className={inputClass}
          />
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
        Send email/push for this update (when enabled on the announcement)
      </label>
      <button
        type="submit"
        disabled={posting || !body.trim()}
        className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-50"
      >
        {posting ? "Posting..." : "Post update"}
      </button>
    </form>
  );
}

function TicketLinks({ id }: { id: string }): React.ReactElement {
  const toast = useToast();
  const [tickets, setTickets] = useState<LinkedTicket[]>([]);
  const [ticketId, setTicketId] = useState("");

  const load = useCallback((): void => {
    apiFetch<LinkedTicket[]>(`/announcements/${id}/tickets`).then(setTickets).catch(() => {});
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const link = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const value = ticketId.trim();
    if (!value) return;
    try {
      await apiFetch(`/announcements/${id}/tickets/${encodeURIComponent(value)}`, { method: "POST" });
      setTicketId("");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not link ticket");
    }
  };

  const unlink = async (ticket: string): Promise<void> => {
    try {
      await apiFetch(`/announcements/${id}/tickets/${encodeURIComponent(ticket)}`, { method: "DELETE" });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not unlink ticket");
    }
  };

  return (
    <div>
      {tickets.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)] mb-3">No linked tickets.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] mb-3">
          {tickets.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <Link href={`/dashboard/tickets/${t.id}`} className="hover:underline min-w-0 truncate">
                <span className="text-[var(--muted-foreground)] mr-2">{t.reference}</span>
                {t.subject}
              </Link>
              <button type="button" onClick={() => unlink(t.id)} aria-label={`Unlink ${t.reference}`} className="shrink-0">
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={link} className="flex gap-2">
        <input
          aria-label="Ticket ID"
          placeholder="Ticket ID"
          maxLength={64}
          value={ticketId}
          onChange={(e) => setTicketId(e.target.value)}
          className={inputClass}
        />
        <button type="submit" className={`${buttonClass} flex items-center gap-1 shrink-0`}>
          <Link2 size={14} />
          Link
        </button>
      </form>
    </div>
  );
}

export default function AnnouncementDetailPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [announcement, setAnnouncement] = useState<AnnouncementDetail | null>(null);
  const [error, setError] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<AnnouncementDetail>(`/announcements/${id}`)
      .then(setAnnouncement)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, [id]);

  const act = async (action: "publish" | "unpublish" | "expire" | "schedule", body?: unknown): Promise<void> => {
    setBusy(true);
    try {
      const updated = await apiFetch<AnnouncementDetail>(`/announcements/${id}/${action}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      setAnnouncement(updated);
      toast.success(
        action === "publish" ? "Published" : action === "schedule" ? "Scheduled" : action === "expire" ? "Expired" : "Moved back to draft",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const publish = async (): Promise<void> => {
    const ok = await confirm({
      title: "Publish announcement?",
      message: "The audience will see it in the portal and be notified as configured.",
      confirmLabel: "Publish",
    });
    if (ok) await act("publish");
  };

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: "Delete announcement?",
      message: "This removes it and its update history for everyone.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/announcements/${id}`, { method: "DELETE" });
      router.push("/dashboard/announcements");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  if (error) return <div className="p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>;
  if (!announcement) return <Skeleton className="h-64 w-full" />;

  const a = announcement;
  return (
    <div>
      <Link
        href="/dashboard/announcements"
        className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] mb-4"
      >
        <ArrowLeft size={14} />
        Announcements
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold">{a.title}</h1>
          <p className="text-sm text-[var(--muted-foreground)]" data-testid="announcement-status">
            {STATUS_LABELS[a.status] ?? a.status}
            {a.status === "scheduled" && a.publishAt ? ` for ${formatDateTime(a.publishAt)}` : ""}
            {a.status === "published" && a.publishedAt ? ` ${formatDateTime(a.publishedAt)}` : ""}
            {a.type === "incident" && a.incidentState ? ` · ${INCIDENT_STATE_LABELS[a.incidentState]}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(a.status === "draft" || a.status === "scheduled") && (
            <button type="button" disabled={busy} onClick={publish} className="px-4 py-1.5 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-50">
              Publish now
            </button>
          )}
          {a.status === "published" && (
            <button type="button" disabled={busy} onClick={() => act("expire")} className={buttonClass}>
              Expire
            </button>
          )}
          {a.status !== "draft" && (
            <button type="button" disabled={busy} onClick={() => act("unpublish")} className={buttonClass}>
              Unpublish
            </button>
          )}
          <button type="button" onClick={remove} aria-label="Delete announcement" className={`${buttonClass} text-red-600`}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {(a.status === "draft" || a.status === "scheduled") && (
        <div className="flex flex-wrap items-end gap-2 mb-8 max-w-2xl">
          <div className="flex-1 min-w-[12rem]">
            <label htmlFor="schedule-at" className="block text-sm font-medium mb-1">
              Schedule publishing
            </label>
            <input
              id="schedule-at"
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className={inputClass}
            />
          </div>
          <button
            type="button"
            disabled={busy || !scheduleAt}
            onClick={() => act("schedule", { publishAt: fromLocalInput(scheduleAt) })}
            className={buttonClass}
          >
            Schedule
          </button>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          <AnnouncementEditor key={`${a.id}-${a.status}`} announcement={a} onSaved={setAnnouncement} />
        </div>
        <div className="space-y-8">
          <section aria-label="Timeline">
            <h2 className="font-semibold mb-3">{a.type === "incident" ? "Incident timeline" : "Updates"}</h2>
            <UpdateForm announcement={a} onPosted={setAnnouncement} />
            <AnnouncementTimeline updates={a.updates} />
            {a.postmortem && (
              <div className="mt-4 rounded-lg bg-[var(--muted)] p-3">
                <p className="text-xs font-semibold uppercase tracking-wide mb-1">Postmortem</p>
                <Markdown source={a.postmortem} />
              </div>
            )}
          </section>
          <section aria-label="Linked tickets">
            <h2 className="font-semibold mb-3">Linked tickets</h2>
            <TicketLinks id={a.id} />
          </section>
        </div>
      </div>
    </div>
  );
}
