import { TICKET_DONE_STATUSES, TICKET_STATUSES, type TicketStatus } from "@atrium/shared";

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

export function isDone(status: string): boolean {
  return (TICKET_DONE_STATUSES as readonly string[]).includes(status);
}

/** Statuses a ticket is still being worked in (shown in the "open" view). */
export const ACTIVE_STATUSES: TicketStatus[] = TICKET_STATUSES.filter((s) => !isDone(s));

export interface StatusTimestamps {
  status: string;
  resolvedAt: Date | null;
  closedAt: Date | null;
  waitingSince: Date | null;
}

/**
 * Timestamp side effects of a status change: resolvedAt/closedAt when a
 * ticket is finished (cleared when it is reopened) and waitingSince while it
 * waits on the client.
 */
export function statusSideEffects(
  ticket: StatusTimestamps,
  next: TicketStatus,
  now: Date,
): { status: TicketStatus; resolvedAt?: Date | null; closedAt?: Date | null; waitingSince?: Date | null } {
  const data: { status: TicketStatus; resolvedAt?: Date | null; closedAt?: Date | null; waitingSince?: Date | null } = {
    status: next,
  };
  if (next === "resolved") {
    data.resolvedAt = now;
    data.closedAt = null;
  } else if (next === "closed") {
    data.closedAt = now;
    if (!ticket.resolvedAt) data.resolvedAt = now;
  } else if (isDone(ticket.status)) {
    data.resolvedAt = null;
    data.closedAt = null;
  }
  if (next === "waiting_client") {
    if (ticket.status !== "waiting_client" || !ticket.waitingSince) data.waitingSince = now;
  } else if (ticket.waitingSince) {
    data.waitingSince = null;
  }
  return data;
}

export type ClientAction = "reply" | "reopen" | "close" | "rate";

/**
 * What a portal client may do to a ticket in its current state. Merged tickets
 * are read-only; closing depends on the workspace setting; rating only once
 * work is finished.
 */
export function clientMay(
  action: ClientAction,
  ticket: { status: string; mergedIntoId: string | null },
  settings: { clientsCanClose: boolean; csatEnabled: boolean },
): boolean {
  if (ticket.mergedIntoId) return false;
  switch (action) {
    case "reply":
      return ticket.status !== "closed";
    case "reopen":
      return ticket.status === "resolved";
    case "close":
      return settings.clientsCanClose && ticket.status !== "closed";
    case "rate":
      return settings.csatEnabled && isDone(ticket.status);
  }
}

/** Status after a client replies: waiting on them or resolved means the ball is back with staff. */
export function statusAfterClientReply(status: string): TicketStatus | null {
  if (status === "waiting_client" || status === "resolved") return "open";
  return null;
}
