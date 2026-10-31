import { INTEGRATION_EVENT_GROUPS } from "@atrium/shared";

const LABELS: ReadonlyMap<string, { group: string; label: string }> = new Map(
  INTEGRATION_EVENT_GROUPS.flatMap((g) => g.events.map((e) => [e.id as string, { group: g.label, label: e.label }] as const)),
);

/** "Invoices · Invoice sent"; an id this build does not know reads as words ("ticket.sla_breached" → "Ticket · Sla breached"). */
export function eventLabel(event: string): string {
  const known = LABELS.get(event);
  if (known) return `${known.group} · ${known.label}`;
  if (event === "test.ping") return "Test message";
  const [head, ...rest] = event.split(".");
  const words = (s: string): string => s.replace(/[_-]+/g, " ").trim();
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const tail = words(rest.join(" "));
  return tail ? `${cap(words(head))} · ${cap(tail)}` : cap(words(head));
}

const DEFAULT_COLOR = 0x6366f1;
const ALERT_COLOR = 0xdc2626;
const GOOD_COLOR = 0x16a34a;
const WARN_COLOR = 0xd97706;

/** Discord embed colour: red for things that went wrong, green for money in, amber for overdue. */
export function eventColor(event: string): number {
  if (event === "ticket.sla_breached" || event === "payments.stripe_disconnected" || event === "estimate.declined") return ALERT_COLOR;
  if (event === "invoice.paid" || event === "estimate.accepted") return GOOD_COLOR;
  if (event === "invoice.overdue" || event === "estimate.changes_requested") return WARN_COLOR;
  return DEFAULT_COLOR;
}

/** Fields shown as name/value pairs when an event's data carries them. Unknown keys are ignored. */
const FACTS: ReadonlyArray<{ key: string; name: string; format?: (v: unknown) => string | null }> = [
  { key: "invoiceNumber", name: "Invoice" },
  { key: "estimateNumber", name: "Estimate" },
  { key: "reference", name: "Reference" },
  { key: "ticketNumber", name: "Ticket" },
  { key: "status", name: "Status", format: (v) => (typeof v === "string" ? v.replace(/_/g, " ") : null) },
  { key: "priority", name: "Priority" },
  { key: "assignee", name: "Assignee" },
  { key: "severity", name: "Severity" },
  {
    key: "dueDate",
    name: "Due",
    format: (v) => {
      if (typeof v !== "string") return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    },
  },
  { key: "daysOverdue", name: "Days overdue", format: (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : null) },
];

export function eventFacts(data: Record<string, unknown> | null | undefined): Array<{ name: string; value: string }> {
  if (!data || typeof data !== "object") return [];
  const facts: Array<{ name: string; value: string }> = [];
  for (const fact of FACTS) {
    const raw = data[fact.key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = fact.format ? fact.format(raw) : typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
    if (value) facts.push({ name: fact.name, value: value.slice(0, 200) });
  }
  return facts.slice(0, 6);
}
