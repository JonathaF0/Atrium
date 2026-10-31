/** How Atrium secures the connection to an SMTP server. */
export const SMTP_SECURITY = {
  TLS: "tls",
  STARTTLS: "starttls",
  NONE: "none",
} as const;

export type SmtpSecurity = (typeof SMTP_SECURITY)[keyof typeof SMTP_SECURITY];

export const SMTP_SECURITY_VALUES: SmtpSecurity[] = Object.values(SMTP_SECURITY);

/** The port each mode normally uses; shown when no port is set. */
export const SMTP_DEFAULT_PORTS: Record<SmtpSecurity, number> = {
  tls: 465,
  starttls: 587,
  none: 25,
};

export const PROJECT_STATUSES = {
  NOT_STARTED: "not_started",
  IN_PROGRESS: "in_progress",
  IN_REVIEW: "in_review",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

export type ProjectStatusValue =
  (typeof PROJECT_STATUSES)[keyof typeof PROJECT_STATUSES];

export const DEFAULT_STATUSES = [
  { name: "Not Started", slug: "not_started", order: 0, color: "#6b7280" },
  { name: "In Progress", slug: "in_progress", order: 1, color: "#3b82f6" },
  { name: "In Review", slug: "in_review", order: 2, color: "#f59e0b" },
  { name: "Completed", slug: "completed", order: 3, color: "#10b981" },
  { name: "Cancelled", slug: "cancelled", order: 4, color: "#ef4444" },
];

export const DEFAULT_BRANDING = {
  primaryColor: "#006b68",
};

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

export const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const DELETED_USER_SENTINEL = "deleted";

export const TASK_STATUSES = {
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  DONE: "done",
  CANCELLED: "cancelled",
} as const;

export type TaskStatusValue =
  (typeof TASK_STATUSES)[keyof typeof TASK_STATUSES];

export const TASK_STATUS_VALUES = Object.values(TASK_STATUSES);

export const TASK_TYPES = {
  CHECKBOX: "checkbox",
  DECISION: "decision",
} as const;

export type TaskTypeValue = (typeof TASK_TYPES)[keyof typeof TASK_TYPES];

export const DEFAULT_LABEL_COLOR = "#6b7280";

export const DEFAULT_LEAD_SOURCES: string[] = ["Referral", "Website", "Event", "Social"];

export const CONTACT_STATUSES = ["lead", "client", "past_client"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_RATINGS = ["hot", "warm", "cold"] as const;
export type ContactRating = (typeof CONTACT_RATINGS)[number];

// A type alias (not an interface) so it is assignable to Prisma's Json input.
export type ContactPhone = {
  label: string;
  number: string;
};

export const FOLLOW_UP_REPEAT_DAYS: readonly number[] = [14, 30, 90, 180, 365];
export const FOLLOW_UP_SNOOZE_DAYS: readonly number[] = [1, 3, 7];

export const CALENDAR_EVENT_TYPES = [
  "task",
  "project_start",
  "project_end",
  "invoice_due",
] as const;

export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

export type CalendarEvent =
  | {
      type: "task";
      id: string;
      date: string;
      title: string;
      status: string;
      projectId: string;
      projectName: string;
      assigneeId: string | null;
      assigneeName: string | null;
    }
  | {
      type: "project_start" | "project_end";
      id: string;
      date: string;
      title: string;
      projectId: string;
      projectName: string;
    }
  | {
      type: "invoice_due";
      id: string;
      date: string;
      title: string;
      status: string;
      projectId: string | null;
      projectName: string | null;
      amountCents: number;
    };

export interface OwnedOrg {
  id: string;
  name: string;
  isSoleOwner: boolean;
  memberCount: number;
}

export interface DeletionInfo {
  ownedOrganizations: OwnedOrg[];
}

/** Features reserved for paid plans on hosted Atrium. Self-hosted installs (billing off) get all of them. */
export const PLAN_FEATURES = [
  "custom_domain",
  "e_signatures",
  "integrations",
  "online_payments",
  "white_label",
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const PLAN_FEATURE_LABELS: Record<PlanFeature, string> = {
  custom_domain: "Custom domains",
  e_signatures: "E-signatures",
  integrations: "Integrations",
  online_payments: "Online invoice payments",
  white_label: "White-label portals",
};

// ─── Integrations ───

export const INTEGRATION_TYPES = ["slack", "discord", "webhook"] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

/** Events a destination can subscribe to, grouped for the settings picker. */
export const INTEGRATION_EVENT_GROUPS = [
  {
    label: "Projects",
    events: [
      { id: "project.update_posted", label: "Update posted" },
      { id: "comment.created", label: "Comment added" },
    ],
  },
  {
    label: "Tasks",
    events: [
      { id: "task.created", label: "Task created" },
      { id: "task.status_changed", label: "Task status changed" },
      { id: "task.assigned", label: "Task assigned" },
      { id: "client_request.created", label: "Client request submitted" },
      { id: "decision.closed", label: "Decision closed" },
    ],
  },
  {
    label: "Documents",
    events: [
      { id: "document.uploaded", label: "Document shared" },
      { id: "document.responded", label: "Client responded (approved, rejected, signed)" },
      { id: "document.signing_turn", label: "Next signer's turn" },
      { id: "document.reminder_sent", label: "Reminder sent" },
    ],
  },
  {
    label: "Invoices",
    events: [
      { id: "invoice.sent", label: "Invoice sent" },
      { id: "invoice.paid", label: "Invoice paid" },
      { id: "invoice.overdue", label: "Overdue reminder sent" },
    ],
  },
  {
    label: "Helpdesk",
    events: [
      { id: "ticket.created", label: "Ticket created" },
      { id: "ticket.replied", label: "Ticket reply added" },
      { id: "ticket.status_changed", label: "Ticket status changed" },
      { id: "ticket.assigned", label: "Ticket assigned" },
      { id: "ticket.sla_breached", label: "Ticket SLA breached" },
    ],
  },
  {
    label: "Estimates",
    events: [
      { id: "estimate.sent", label: "Estimate sent" },
      { id: "estimate.accepted", label: "Estimate accepted" },
      { id: "estimate.declined", label: "Estimate declined" },
      { id: "estimate.changes_requested", label: "Estimate changes requested" },
    ],
  },
  {
    label: "Announcements",
    events: [
      { id: "announcement.published", label: "Announcement published" },
      { id: "announcement.updated", label: "Incident update posted" },
    ],
  },
  {
    label: "Workspace",
    events: [{ id: "payments.stripe_disconnected", label: "Stripe disconnected" }],
  },
] as const;

export type IntegrationEvent =
  (typeof INTEGRATION_EVENT_GROUPS)[number]["events"][number]["id"];

export const INTEGRATION_EVENTS: readonly IntegrationEvent[] = INTEGRATION_EVENT_GROUPS.flatMap(
  (g) => g.events.map((e) => e.id),
);

// ── Contact mentions in notes ─────────────────────────────────────────────────
// A note stores "@[Ann Lee](contact:<id>)"; the app shows it as a link to that contact.

const MENTION_PATTERN = /@\[([^\]\n]{1,200})\]\(contact:([A-Za-z0-9_-]{1,64})\)/g;

export interface NoteMention {
  name: string;
  contactId: string;
}

export type NotePart = { text: string } | { mention: NoteMention };

export function mentionToken(name: string, contactId: string): string {
  const safe = name.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
  return `@[${safe}](contact:${contactId})`;
}

export function splitMentions(content: string): NotePart[] {
  const parts: NotePart[] = [];
  let last = 0;
  for (const m of content.matchAll(MENTION_PATTERN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: content.slice(last, at) });
    parts.push({ mention: { name: m[1], contactId: m[2] } });
    last = at + m[0].length;
  }
  if (last < content.length || parts.length === 0) parts.push({ text: content.slice(last) });
  return parts;
}

/** Each mentioned contact id once, in order of first mention. */
export function mentionedContactIds(content: string): string[] {
  return [...new Set([...content.matchAll(MENTION_PATTERN)].map((m) => m[2]))];
}

/** The note with every mention as a plain "@Name". */
export function mentionsAsText(content: string): string {
  return content.replace(MENTION_PATTERN, (_, name: string) => `@${name}`);
}

/** Replaces mentions of contacts not in `keep` with their plain "@Name". */
export function keepMentions(content: string, keep: ReadonlySet<string>): string {
  return content.replace(MENTION_PATTERN, (token: string, name: string, id: string) =>
    keep.has(id) ? token : `@${name}`,
  );
}

/** Currency used when STRIPE_CURRENCY is unset. */
export const DEFAULT_CURRENCY = "usd";

/** Formats an amount in minor units (cents) as a localized currency string. */
export function formatMoney(cents: number, currency: string = DEFAULT_CURRENCY): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

// ─── Helpdesk ───

export const TICKET_STATUSES = [
  "new",
  "open",
  "waiting_client",
  "waiting_third_party",
  "on_hold",
  "resolved",
  "closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  waiting_client: "Waiting on client",
  waiting_third_party: "Waiting on third party",
  on_hold: "On hold",
  resolved: "Resolved",
  closed: "Closed",
};

/** Statuses that stop the SLA clock. */
export const SLA_PAUSED_STATUSES: readonly TicketStatus[] = ["waiting_client", "waiting_third_party", "on_hold"];

/** Statuses a ticket can no longer breach its SLA in. */
export const TICKET_DONE_STATUSES: readonly TicketStatus[] = ["resolved", "closed"];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const TICKET_LEVELS = ["low", "medium", "high"] as const;
export type TicketLevel = (typeof TICKET_LEVELS)[number];

/** Priority from impact × urgency (ITIL-style matrix). */
export function priorityFromImpact(impact: TicketLevel, urgency: TicketLevel): TicketPriority {
  const score: number = TICKET_LEVELS.indexOf(impact) + TICKET_LEVELS.indexOf(urgency);
  if (score >= 4) return "urgent";
  if (score === 3) return "high";
  if (score === 2) return "normal";
  return "low";
}

export const TICKET_SOURCES = ["portal", "email", "staff", "api"] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const TICKET_QUEUE_VIEWS = ["all", "unassigned", "mine", "triage", "sla_risk", "open", "closed"] as const;
export type TicketQueueView = (typeof TICKET_QUEUE_VIEWS)[number];

// Type aliases (not interfaces) so they are assignable to Prisma's Json input.
export type SlaTarget = {
  firstResponseMins: number;
  resolutionMins: number;
};
export type SlaTargets = Record<TicketPriority, SlaTarget>;

export const DEFAULT_SLA_TARGETS: SlaTargets = {
  urgent: { firstResponseMins: 60, resolutionMins: 8 * 60 },
  high: { firstResponseMins: 4 * 60, resolutionMins: 2 * 8 * 60 },
  normal: { firstResponseMins: 8 * 60, resolutionMins: 5 * 8 * 60 },
  low: { firstResponseMins: 2 * 8 * 60, resolutionMins: 10 * 8 * 60 },
};

export const DEFAULT_BUSINESS_SCHEDULE: { day: number; start: string; end: string }[] = [1, 2, 3, 4, 5].map(
  (day) => ({ day, start: "09:00", end: "17:00" }),
);

export const DEFAULT_TICKET_CATEGORIES: { name: string; description: string; color: string; defaultPriority: TicketPriority }[] = [
  { name: "General question", description: "Questions and how-to requests", color: "#6b7280", defaultPriority: "normal" },
  { name: "Hardware", description: "Computers, printers and other devices", color: "#3b82f6", defaultPriority: "normal" },
  { name: "Software", description: "Applications, updates and installs", color: "#8b5cf6", defaultPriority: "normal" },
  { name: "Network and internet", description: "Connectivity, Wi-Fi and VPN", color: "#0ea5e9", defaultPriority: "high" },
  { name: "Email and accounts", description: "Mailboxes, sign-in and access", color: "#f59e0b", defaultPriority: "normal" },
  { name: "Security", description: "Suspicious email, malware or a possible breach", color: "#ef4444", defaultPriority: "high" },
  { name: "New user or change request", description: "Onboarding, offboarding and changes", color: "#10b981", defaultPriority: "low" },
];

export const AUTOMATION_TRIGGERS = ["ticket_created", "ticket_updated"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export const AUTOMATION_FIELDS = ["categoryId", "priority", "source", "companyId", "subject", "status"] as const;
export type AutomationField = (typeof AUTOMATION_FIELDS)[number];
export const AUTOMATION_OPS = ["eq", "neq", "contains"] as const;
export type AutomationOp = (typeof AUTOMATION_OPS)[number];
export const AUTOMATION_ACTIONS = ["set_priority", "assign", "set_category", "add_label", "set_status"] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTIONS)[number];

export interface AutomationCondition {
  field: AutomationField;
  op: AutomationOp;
  value: string;
}
export interface AutomationAction {
  type: AutomationActionType;
  value: string;
}

/** Variables available in canned responses. */
export const CANNED_RESPONSE_VARIABLES = [
  "ticket.number",
  "ticket.subject",
  "ticket.status",
  "requester.name",
  "requester.firstName",
  "company.name",
  "agent.name",
  "agent.firstName",
  "workspace.name",
] as const;

// ─── Knowledge base ───

export const KB_VISIBILITIES = ["public", "clients", "restricted", "internal"] as const;
export type KbVisibility = (typeof KB_VISIBILITIES)[number];

export const KB_VISIBILITY_LABELS: Record<KbVisibility, string> = {
  public: "Public",
  clients: "All clients",
  restricted: "Selected clients",
  internal: "Staff only",
};

export const KB_ARTICLE_STATUSES = ["draft", "in_review", "published", "archived"] as const;
export type KbArticleStatus = (typeof KB_ARTICLE_STATUSES)[number];

export const CLIENT_DOC_SECTIONS = ["network", "onboarding", "runbook", "vendors", "licenses", "other"] as const;
export type ClientDocSection = (typeof CLIENT_DOC_SECTIONS)[number];

export const CLIENT_DOC_SECTION_LABELS: Record<ClientDocSection, string> = {
  network: "Network and diagrams",
  onboarding: "Onboarding",
  runbook: "Runbooks",
  vendors: "Vendors and contacts",
  licenses: "Licenses and renewals",
  other: "Other",
};

// ─── Estimates and catalog ───

export const BILLING_TYPES = ["hourly", "fixed", "recurring"] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

export const RECURRING_INTERVALS = ["weekly", "monthly", "quarterly", "yearly"] as const;
export type RecurringInterval = (typeof RECURRING_INTERVALS)[number];

export const ESTIMATE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "changes_requested",
  "accepted",
  "declined",
  "expired",
  "superseded",
  "converted",
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export interface EstimateLineLike {
  quantity: number;
  unitPriceCents: number;
  taxRateBps: number;
  taxable: boolean;
  optional: boolean;
  selected: boolean;
  billingType: BillingType;
}

export interface EstimateTotals {
  oneTimeSubtotalCents: number;
  recurringSubtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
}

/**
 * Totals for an estimate. Optional items count only when selected. The discount
 * applies to one-time items and is spread across them before tax, so taxable
 * and non-taxable lines are discounted proportionally. Recurring items are
 * shown separately (per period) and are not part of the one-time total.
 */
export function computeEstimateTotals(
  lines: EstimateLineLike[],
  discount: { type: "percent" | "amount" | null; value: number | null },
  depositPercent: number | null,
): EstimateTotals {
  const included = lines.filter((l) => !l.optional || l.selected);
  const lineTotal = (l: EstimateLineLike): number => Math.round(l.quantity * l.unitPriceCents);
  const oneTime = included.filter((l) => l.billingType !== "recurring");
  const recurring = included.filter((l) => l.billingType === "recurring");
  const oneTimeSubtotalCents: number = oneTime.reduce((sum, l) => sum + lineTotal(l), 0);
  const recurringSubtotalCents: number = recurring.reduce((sum, l) => sum + lineTotal(l), 0);

  let discountCents = 0;
  if (discount.type === "percent" && discount.value) {
    discountCents = Math.round((oneTimeSubtotalCents * Math.min(discount.value, 10000)) / 10000);
  } else if (discount.type === "amount" && discount.value) {
    discountCents = Math.min(discount.value, oneTimeSubtotalCents);
  }
  const factor: number = oneTimeSubtotalCents > 0 ? 1 - discountCents / oneTimeSubtotalCents : 1;
  const taxCents: number = oneTime
    .filter((l) => l.taxable && l.taxRateBps > 0)
    .reduce((sum, l) => sum + Math.round((lineTotal(l) * factor * l.taxRateBps) / 10000), 0);
  const totalCents: number = oneTimeSubtotalCents - discountCents + taxCents;
  const depositCents: number = depositPercent ? Math.round((totalCents * Math.min(depositPercent, 100)) / 100) : 0;
  return { oneTimeSubtotalCents, recurringSubtotalCents, discountCents, taxCents, totalCents, depositCents };
}

/** Tax on one invoice line in cents (unitPrice and quantity as stored on InvoiceLineItem). */
export function lineTaxCents(quantity: number, unitPrice: number, taxRateBps: number): number {
  return taxRateBps > 0 ? Math.round((quantity * unitPrice * taxRateBps) / 10000) : 0;
}

// ─── Assets, contracts, announcements ───

export const ASSET_TYPES = ["device", "software_license", "domain", "ssl_certificate", "cloud_service", "other"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  device: "Device",
  software_license: "Software license",
  domain: "Domain",
  ssl_certificate: "SSL certificate",
  cloud_service: "Cloud service",
  other: "Other",
};

export const CONTRACT_TYPES = ["msa", "sla", "retainer", "block_hours", "other"] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  msa: "Master services agreement",
  sla: "Service level agreement",
  retainer: "Retainer",
  block_hours: "Block of hours",
  other: "Other",
};

export const ANNOUNCEMENT_TYPES = ["general", "maintenance", "incident", "security"] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export const ANNOUNCEMENT_SEVERITIES = ["info", "minor", "major", "critical"] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

export const INCIDENT_STATES = ["investigating", "identified", "monitoring", "resolved"] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export const ANNOUNCEMENT_AUDIENCES = ["all", "companies", "contracts", "assets"] as const;
export type AnnouncementAudienceType = (typeof ANNOUNCEMENT_AUDIENCES)[number];
