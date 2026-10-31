import { TICKET_STATUS_LABELS, type TicketStatus } from "@atrium/shared";
import { fillTemplate, formatReference } from "../service-core";

export interface CannedContext {
  ticket: { number: number; subject: string; status: string };
  prefix: string;
  requesterName: string | null;
  companyName: string | null;
  agentName: string | null;
  workspaceName: string;
}

function firstName(name: string | null): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** Values for every name in CANNED_RESPONSE_VARIABLES. */
export function cannedVariables(ctx: CannedContext): Record<string, string> {
  return {
    "ticket.number": formatReference(ctx.prefix, ctx.ticket.number),
    "ticket.subject": ctx.ticket.subject,
    "ticket.status": TICKET_STATUS_LABELS[ctx.ticket.status as TicketStatus] ?? ctx.ticket.status,
    "requester.name": ctx.requesterName ?? "",
    "requester.firstName": firstName(ctx.requesterName),
    "company.name": ctx.companyName ?? "",
    "agent.name": ctx.agentName ?? "",
    "agent.firstName": firstName(ctx.agentName),
    "workspace.name": ctx.workspaceName,
  };
}

export function renderCanned(body: string, ctx: CannedContext): string {
  return fillTemplate(body, cannedVariables(ctx));
}
