"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, Star } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { AttachmentList, StatusBadge, formatDateTime, priorityLabel, statusLabel, uploadAttachments, type TicketMessage } from "@/lib/tickets";

interface PortalTicketDetail {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  requesterName: string | null;
  own: boolean;
  category: { name: string } | null;
  assigneeName: string | null;
  mergedIntoId: string | null;
  csatRating: number | null;
  csatComment: string | null;
  messages: TicketMessage[];
  events: { id: string; type: string; fromValue: string | null; toValue: string | null; createdAt: string }[];
  can: { reply: boolean; reopen: boolean; close: boolean; rate: boolean };
}

export default function PortalTicketPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [ticket, setTicket] = useState<PortalTicketDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(searchParams.get("uploadFailed") ? "Some attachments could not be uploaded." : "");
  const [reply, setReply] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");

  const load = useCallback(async () => {
    try {
      const t = await apiFetch<PortalTicketDetail>(`/tickets/mine/${id}`);
      setTicket(t);
      setRating(t.csatRating ?? 0);
      setComment(t.csatComment ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request not found");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const sendReply = (e: React.FormEvent): void => {
    e.preventDefault();
    void act(async () => {
      const message = await apiFetch<{ id: string }>(`/tickets/mine/${id}/reply`, { method: "POST", body: JSON.stringify({ body: reply }) });
      if (files.length > 0) {
        const failed = await uploadAttachments(`/tickets/mine/${id}`, message.id, files);
        setNotice(failed.length > 0 ? `Not uploaded: ${failed.join("; ")}` : "");
      }
      setReply("");
      setFiles([]);
    });
  };

  if (error && !ticket) return <div className="p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>;
  if (!ticket) return <div className="text-sm text-[var(--muted-foreground)]">Loading...</div>;

  return (
    <div className="max-w-3xl">
      <Link href="/portal/tickets" className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] mb-4">
        <ArrowLeft size={14} /> Back to requests
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm text-[var(--muted-foreground)]">{ticket.reference}</div>
          <h1 className="text-2xl font-bold break-words">{ticket.subject}</h1>
        </div>
        <StatusBadge status={ticket.status} />
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-[var(--muted-foreground)] mb-6">
        <span>Opened {formatDateTime(ticket.createdAt)}</span>
        {ticket.category && <span>{ticket.category.name}</span>}
        <span>Priority: {priorityLabel(ticket.priority)}</span>
        {ticket.assigneeName && <span>Handled by {ticket.assigneeName}</span>}
        {!ticket.own && ticket.requesterName && <span>Requested by {ticket.requesterName}</span>}
      </div>

      {ticket.mergedIntoId && (
        <div className="mb-4 p-3 text-sm bg-[var(--muted)] rounded-lg">
          This request was merged.{" "}
          <Link href={`/portal/tickets/${ticket.mergedIntoId}`} className="underline">
            Continue in the merged request
          </Link>
          .
        </div>
      )}
      {error && <div className="mb-4 p-3 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}
      {notice && <div className="mb-4 p-3 text-sm text-amber-800 bg-amber-50 rounded-lg">{notice}</div>}

      <ol className="space-y-4" aria-label="Conversation">
        {ticket.messages.map((m) => (
          <li key={m.id} className="border border-[var(--border)] rounded-lg p-4" data-testid="ticket-message">
            <div className="flex items-center justify-between gap-2 mb-2 text-xs text-[var(--muted-foreground)]">
              <span className="font-medium text-[var(--foreground)]">{m.authorName ?? "Support"}</span>
              <span>{formatDateTime(m.createdAt)}</span>
            </div>
            <Markdown source={m.body} />
            <AttachmentList attachments={m.attachments} pathFor={(aid) => `/tickets/mine/attachments/${aid}`} />
          </li>
        ))}
      </ol>

      {ticket.events.filter((e) => e.type === "status").length > 0 && (
        <details className="mt-4 text-xs text-[var(--muted-foreground)]">
          <summary className="cursor-pointer">Status history</summary>
          <ul className="mt-2 space-y-1">
            {ticket.events
              .filter((e) => e.type === "status")
              .map((e) => (
                <li key={e.id}>
                  {formatDateTime(e.createdAt)}: {statusLabel(e.fromValue ?? "")} to {statusLabel(e.toValue ?? "")}
                </li>
              ))}
          </ul>
        </details>
      )}

      {ticket.can.rate && (
        <section className="mt-6 p-4 border border-[var(--border)] rounded-lg" aria-label="Rate this request">
          <h2 className="font-medium mb-2">How did we do?</h2>
          <div className="flex gap-1 mb-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-label={`${n} star${n > 1 ? "s" : ""}`} onClick={() => setRating(n)}>
                <Star size={22} className={n <= rating ? "fill-amber-400 text-amber-400" : "text-[var(--muted-foreground)]"} />
              </button>
            ))}
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Anything to add? (optional)"
            className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
          />
          <button
            type="button"
            disabled={!rating || busy}
            onClick={() => void act(() => apiFetch(`/tickets/mine/${id}/csat`, { method: "POST", body: JSON.stringify({ rating, comment }) }))}
            className="mt-2 px-3 py-1.5 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-50"
          >
            {ticket.csatRating ? "Update rating" : "Submit rating"}
          </button>
          {ticket.csatRating && <p className="mt-2 text-xs text-[var(--muted-foreground)]">Thanks for your feedback.</p>}
        </section>
      )}

      {ticket.can.reply && (
        <form onSubmit={sendReply} className="mt-6 space-y-2">
          <label htmlFor="portal-reply" className="block text-sm font-medium">
            Reply
          </label>
          <textarea
            id="portal-reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={4}
            maxLength={50000}
            className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
            placeholder="Add more details or answer a question. Markdown is supported."
          />
          <div className="flex flex-wrap items-center gap-3">
            <input type="file" multiple aria-label="Attach files" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))} className="text-sm" />
            <button type="submit" disabled={busy || !reply.trim()} className="ml-auto px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium disabled:opacity-50">
              Send reply
            </button>
          </div>
        </form>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {ticket.can.reopen && (
          <button type="button" disabled={busy} onClick={() => void act(() => apiFetch(`/tickets/mine/${id}/reopen`, { method: "POST" }))} className="px-3 py-1.5 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]">
            Reopen request
          </button>
        )}
        {ticket.can.close && (
          <button type="button" disabled={busy} onClick={() => void act(() => apiFetch(`/tickets/mine/${id}/close`, { method: "POST" }))} className="px-3 py-1.5 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]">
            Close request
          </button>
        )}
      </div>
    </div>
  );
}
