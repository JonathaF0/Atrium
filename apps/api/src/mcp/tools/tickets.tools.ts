import * as z from "zod/v4";
import { TICKET_PRIORITIES, TICKET_QUEUE_VIEWS, TICKET_STATUSES } from "@atrium/shared";
import { defineTool, paging } from "../tool-kit";
import type { McpTool } from "../tool-kit";
import type { Actor } from "../../common";
import type { TicketActor, TicketsService } from "../../helpdesk/tickets.service";

function ticketActor(actor: Actor): TicketActor {
  return { userId: actor.user.id, name: actor.user.name, email: actor.user.email };
}

export function ticketTools(deps: { tickets: TicketsService }): McpTool[] {
  const { tickets } = deps;
  return [
    defineTool({
      name: "list_tickets",
      description:
        "Lists helpdesk tickets. view: open (default), unassigned, mine, triage (unknown email senders), sla_risk, closed or all. q matches the subject or the ticket number.",
      inputSchema: z.object({
        view: z.enum(TICKET_QUEUE_VIEWS).default("open"),
        status: z.enum(TICKET_STATUSES).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        assigneeId: z.string().max(64).optional().describe("userId of a team member, or 'none' for unassigned"),
        companyId: z.string().max(64).optional(),
        q: z.string().max(200).optional(),
        ...paging,
      }),
      handler: async (input, actor) => tickets.list(actor.organization.id, actor.user.id, input),
    }),
    defineTool({
      name: "get_ticket",
      description: "Gets a ticket with its full conversation, including internal notes, and its event history.",
      inputSchema: z.object({ ticketId: z.string().max(64) }),
      handler: async (input, actor) => tickets.findOne(input.ticketId, actor.organization.id),
    }),
    defineTool({
      name: "add_ticket_note",
      description: "Adds an internal note to a ticket. Only the team sees it; the client is not notified.",
      inputSchema: z.object({ ticketId: z.string().max(64), body: z.string().trim().min(1).max(20000).describe("Markdown") }),
      handler: async (input, actor) =>
        tickets.reply(input.ticketId, actor.organization.id, ticketActor(actor), { body: input.body, visibility: "internal" }),
    }),
    defineTool({
      name: "reply_to_ticket",
      description:
        "Posts a public reply on a ticket. The client sees it and is emailed. Optionally sets the status at the same time (e.g. waiting_client or resolved).",
      inputSchema: z.object({
        ticketId: z.string().max(64),
        body: z.string().trim().min(1).max(20000).describe("Markdown"),
        status: z.enum(TICKET_STATUSES).optional(),
      }),
      handler: async (input, actor) =>
        tickets.reply(input.ticketId, actor.organization.id, ticketActor(actor), { body: input.body, visibility: "public", status: input.status }),
    }),
    defineTool({
      name: "update_ticket",
      description: "Changes a ticket's status, priority or assignee. Pass null for assigneeId to unassign.",
      inputSchema: z.object({
        ticketId: z.string().max(64),
        status: z.enum(TICKET_STATUSES).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        assigneeId: z.string().max(64).nullable().optional().describe("userId of an owner or admin"),
      }),
      handler: async (input, actor) => {
        const { ticketId, ...dto } = input;
        return tickets.update(ticketId, actor.organization.id, ticketActor(actor), dto);
      },
    }),
  ];
}
