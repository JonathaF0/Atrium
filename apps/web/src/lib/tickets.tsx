import { Paperclip } from "lucide-react";
import { TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS, type TicketPriority, type TicketStatus } from "@atrium/shared";
import { API_URL } from "@/lib/download";
import { apiFetch } from "@/lib/api";
import { formatBytes } from "@/lib/utils";

export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: string;
}

export interface TicketMessage {
  id: string;
  authorUserId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  visibility: "public" | "internal";
  body: string;
  source: string;
  createdAt: string;
  attachments: TicketAttachment[];
}

const STATUS_CLASSES: Record<string, string> = {
  new: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  open: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  waiting_client: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  waiting_third_party: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  on_hold: "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200",
  resolved: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  closed: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

const PRIORITY_CLASSES: Record<string, string> = {
  low: "text-gray-500",
  normal: "text-[var(--foreground)]",
  high: "text-orange-600 dark:text-orange-400",
  urgent: "text-red-600 dark:text-red-400 font-semibold",
};

export function statusLabel(status: string): string {
  return TICKET_STATUS_LABELS[status as TicketStatus] ?? status;
}

export function priorityLabel(priority: string): string {
  return TICKET_PRIORITY_LABELS[priority as TicketPriority] ?? priority;
}

export function StatusBadge({ status }: { status: string }): React.ReactElement {
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_CLASSES[status] ?? STATUS_CLASSES.closed}`}>
      {statusLabel(status)}
    </span>
  );
}

export function PriorityText({ priority }: { priority: string }): React.ReactElement {
  return <span className={`text-xs ${PRIORITY_CLASSES[priority] ?? ""}`}>{priorityLabel(priority)}</span>;
}

/** Downloads through fetch so the session cookie goes along; the API decides inline vs attachment. */
export async function downloadAttachment(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API_URL}/api${path}`, { credentials: "include" });
  if (!res.ok) throw new Error("Download failed");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function AttachmentList({
  attachments,
  pathFor,
}: {
  attachments: TicketAttachment[];
  pathFor: (id: string) => string;
}): React.ReactElement | null {
  if (attachments.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {attachments.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => void downloadAttachment(pathFor(a.id), a.filename)}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-[var(--border)] rounded-md hover:bg-[var(--muted)]"
          >
            <Paperclip size={12} />
            {a.filename}
            <span className="text-[var(--muted-foreground)]">({formatBytes(a.sizeBytes)})</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Uploads files one by one onto a message; returns the names that failed. */
export async function uploadAttachments(basePath: string, messageId: string, files: File[]): Promise<string[]> {
  const failed: string[] = [];
  for (const file of files) {
    const form = new FormData();
    form.append("file", file);
    try {
      await apiFetch(`${basePath}/attachments?messageId=${encodeURIComponent(messageId)}`, { method: "POST", body: form });
    } catch (err) {
      failed.push(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
    }
  }
  return failed;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "in 2h 10m" / "3h 5m overdue" for an SLA due date. */
export function dueIn(iso: string | null, now: number = Date.now()): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const diff: number = new Date(iso).getTime() - now;
  const mins: number = Math.round(Math.abs(diff) / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const span: string = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return diff >= 0 ? { text: `in ${span}`, overdue: false } : { text: `${span} overdue`, overdue: true };
}
