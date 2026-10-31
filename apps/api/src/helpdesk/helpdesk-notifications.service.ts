import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { randomBytes } from "crypto";
import {
  TicketAcknowledgementEmail,
  TicketCreatedEmail,
  TicketReplyEmail,
  TicketStatusEmail,
} from "@atrium/email";
import {
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  type IntegrationEvent,
  type TicketPriority,
  type TicketStatus,
} from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { EmailRenderer } from "../mail/email-renderer";
import { InAppNotificationsService } from "../notifications/in-app-notifications.service";
import { PushService } from "../notifications/push.service";
import { IntegrationDispatcher } from "../integrations/integration-dispatcher.service";
import { excerpt, formatReference, markdownToPlainText } from "../service-core";
import { plusAddress } from "./inbound/email-parsing";

/** Ticket fields every notification needs. */
const TICKET_SELECT = {
  id: true,
  organizationId: true,
  number: true,
  subject: true,
  status: true,
  priority: true,
  emailToken: true,
  requesterEmail: true,
  requesterName: true,
  requesterUserId: true,
  assigneeId: true,
  triage: true,
  projectId: true,
  slaPolicyId: true,
} as const;

type TicketRow = {
  id: string;
  organizationId: string;
  number: number;
  subject: string;
  status: string;
  priority: string;
  emailToken: string;
  requesterEmail: string | null;
  requesterName: string | null;
  requesterUserId: string | null;
  assigneeId: string | null;
  triage: boolean;
  projectId: string | null;
  slaPolicyId: string | null;
};

/** Message-ids we send embed the token, so a reply's In-Reply-To finds the ticket even without a stored message. */
export function outboundMessageId(token: string, domain: string): string {
  return `t.${token}.${randomBytes(6).toString("hex")}@${domain}`;
}

export const OUTBOUND_ID_TOKEN = /^t\.([A-Za-z0-9_-]{16,64})\.[0-9a-f]+@/;

/**
 * Helpdesk notifications: in-app, push, email and integration events. Every
 * method is fire-and-forget; failures are logged, never thrown. Internal notes
 * never reach the requester: only public message bodies are ever passed in.
 */
@Injectable()
export class HelpdeskNotificationsService {
  private readonly webUrl: string;

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private renderer: EmailRenderer,
    private inApp: InAppNotificationsService,
    private push: PushService,
    private integrations: IntegrationDispatcher,
    config: ConfigService,
    @InjectPinoLogger(HelpdeskNotificationsService.name) private readonly logger: PinoLogger,
  ) {
    this.webUrl = config.get("WEB_URL", "http://localhost:3000").replace(/\/+$/, "");
  }

  ticketCreated(ticketId: string, opts: { acknowledge: boolean }): void {
    this.run("ticket created", ticketId, async () => {
      const ctx = await this.context(ticketId);
      if (!ctx) return;
      const { ticket, ref } = ctx;
      const firstMessage = await this.prisma.ticketMessage.findFirst({
        where: { ticketId, visibility: "public" },
        orderBy: { createdAt: "asc" },
        select: { body: true },
      });
      const requester: string = ticket.requesterName || ticket.requesterEmail || "A client";
      this.dispatch("ticket.created", ticket, `New ticket ${ref}: ${ticket.subject}`, requester);
      const recipients = await this.staffRecipients(ticket.organizationId, ticket.assigneeId ? [ticket.assigneeId] : null);
      const link = `/dashboard/tickets/${ticket.id}`;
      this.inAppAndPush(recipients.map((r) => r.userId), ticket.organizationId, "ticket_created", `New ticket ${ref}`, `${requester}: ${ticket.subject}`, link);
      await Promise.allSettled(
        recipients.map(async (r) => {
          const html: string = await this.renderer.render(
            TicketCreatedEmail({
              recipientName: r.name,
              ticketRef: ref,
              subject: ticket.subject,
              requesterName: requester,
              priority: TICKET_PRIORITY_LABELS[ticket.priority as TicketPriority] ?? ticket.priority,
              excerpt: firstMessage ? excerpt(firstMessage.body, 600) : "",
              ticketUrl: `${this.webUrl}${link}`,
            }),
          );
          await this.mail.send(r.email, `[${ref}] New ticket: ${ticket.subject}`, html, ticket.organizationId);
        }),
      );
      if (opts.acknowledge && !ticket.triage) await this.sendAcknowledgement(ctx);
    });
  }

  /** A staff member posted a public reply. `body` is the public message's markdown. */
  staffReplied(ticketId: string, messageId: string, authorName: string, body: string): void {
    this.run("staff reply", ticketId, async () => {
      const ctx = await this.context(ticketId);
      if (!ctx) return;
      const { ticket, ref } = ctx;
      this.dispatch("ticket.replied", ticket, `${authorName} replied to ${ref}`, authorName, excerpt(body, 300));
      if (ticket.requesterUserId) {
        this.inAppAndPush([ticket.requesterUserId], ticket.organizationId, "ticket_reply", `New reply on ${ref}`, excerpt(body, 120), `/portal/tickets/${ticket.id}`);
      }
      if (!ticket.requesterEmail) return;
      const html: string = await this.renderer.render(
        TicketReplyEmail({
          recipientName: ticket.requesterName ?? "",
          authorName,
          ticketRef: ref,
          subject: ticket.subject,
          body: markdownToPlainText(body),
          ticketUrl: this.portalUrl(ticket),
          reference: ctx.reference,
          canReplyByEmail: !!ctx.replyTo,
        }),
      );
      const messageIdHeader: string = outboundMessageId(ticket.emailToken, ctx.domain);
      await this.prisma.ticketMessage.updateMany({ where: { id: messageId, ticketId }, data: { emailMessageId: messageIdHeader } });
      await this.mail.send(ticket.requesterEmail, `[${ref}] ${ticket.subject}`, html, ticket.organizationId, {
        replyTo: ctx.replyTo ?? undefined,
        headers: await this.threadHeaders(ticket, messageIdHeader),
      });
    });
  }

  /** The requester (or a colleague) replied, from the portal or by email. */
  clientReplied(ticketId: string, authorName: string, body: string): void {
    this.run("client reply", ticketId, async () => {
      const ctx = await this.context(ticketId);
      if (!ctx) return;
      const { ticket, ref } = ctx;
      this.dispatch("ticket.replied", ticket, `${authorName} replied to ${ref}`, authorName, excerpt(body, 300));
      const recipients = await this.staffRecipients(ticket.organizationId, ticket.assigneeId ? [ticket.assigneeId] : null);
      this.inAppAndPush(recipients.map((r) => r.userId), ticket.organizationId, "ticket_client_reply", `${authorName} replied to ${ref}`, excerpt(body, 120), `/dashboard/tickets/${ticket.id}`);
    });
  }

  statusChanged(ticketId: string, from: string, to: string, opts: { notifyRequester: boolean; note?: string }): void {
    this.run("status change", ticketId, async () => {
      const ctx = await this.context(ticketId);
      if (!ctx) return;
      const { ticket, ref } = ctx;
      const label: string = TICKET_STATUS_LABELS[to as TicketStatus] ?? to;
      this.dispatch("ticket.status_changed", ticket, `${ref} is now ${label}`, undefined, undefined, { from, to });
      if (!opts.notifyRequester) return;
      // Only the changes a client cares about; internal shuffling (on hold, third party) stays quiet.
      if (!["waiting_client", "resolved", "closed", "open"].includes(to)) return;
      if (ticket.requesterUserId) {
        this.inAppAndPush([ticket.requesterUserId], ticket.organizationId, "ticket_status", `${ref} is now ${label}`, ticket.subject, `/portal/tickets/${ticket.id}`);
      }
      if (!ticket.requesterEmail) return;
      const html: string = await this.renderer.render(
        TicketStatusEmail({
          recipientName: ticket.requesterName ?? "",
          ticketRef: ref,
          subject: ticket.subject,
          statusLabel: label,
          note: opts.note,
          ticketUrl: this.portalUrl(ticket),
          reference: ctx.reference,
          canReplyByEmail: !!ctx.replyTo,
        }),
      );
      await this.mail.send(ticket.requesterEmail, `[${ref}] ${ticket.subject}`, html, ticket.organizationId, {
        replyTo: ctx.replyTo ?? undefined,
        headers: await this.threadHeaders(ticket, outboundMessageId(ticket.emailToken, ctx.domain)),
      });
    });
  }

  assigned(ticketId: string, assigneeId: string, actorId: string | null): void {
    this.run("assignment", ticketId, async () => {
      const ctx = await this.context(ticketId);
      if (!ctx) return;
      const { ticket, ref } = ctx;
      this.dispatch("ticket.assigned", ticket, `${ref} assigned`, undefined, undefined, { assigneeId });
      if (assigneeId === actorId) return;
      this.inAppAndPush([assigneeId], ticket.organizationId, "ticket_assigned", `${ref} assigned to you`, ticket.subject, `/dashboard/tickets/${ticket.id}`);
    });
  }

  slaWarning(ticketId: string, kind: "first_response" | "resolution"): void {
    this.run("SLA warning", ticketId, async () => {
      const ctx = await this.context(ticketId);
      if (!ctx) return;
      const { ticket, ref } = ctx;
      const recipients: string[] = ticket.assigneeId
        ? [ticket.assigneeId]
        : (await this.staffRecipients(ticket.organizationId, null)).map((r) => r.userId);
      const what: string = kind === "first_response" ? "First response" : "Resolution";
      this.inAppAndPush(recipients, ticket.organizationId, "ticket_sla_warning", `${what} due soon on ${ref}`, ticket.subject, `/dashboard/tickets/${ticket.id}`);
    });
  }

  slaBreached(ticketId: string, kind: "first_response" | "resolution", escalateToId: string | null): void {
    this.run("SLA breach", ticketId, async () => {
      const ctx = await this.context(ticketId);
      if (!ctx) return;
      const { ticket, ref } = ctx;
      const what: string = kind === "first_response" ? "First response" : "Resolution";
      this.dispatch("ticket.sla_breached", ticket, `${what} SLA breached on ${ref}`, undefined, ticket.subject, { kind });
      const admins = await this.staffRecipients(ticket.organizationId, null);
      const ids = new Set<string>(admins.map((a) => a.userId));
      if (ticket.assigneeId) ids.add(ticket.assigneeId);
      if (escalateToId) ids.add(escalateToId);
      this.inAppAndPush([...ids], ticket.organizationId, "ticket_sla_breached", `${what} SLA breached on ${ref}`, ticket.subject, `/dashboard/tickets/${ticket.id}`);
    });
  }

  // ─── internals ───

  private run(what: string, ticketId: string, task: () => Promise<void>): void {
    task().catch((err: unknown) => this.logger.error({ err, ticketId }, `Failed to send ticket ${what} notifications`));
  }

  private async sendAcknowledgement(ctx: TicketContext): Promise<void> {
    const { ticket, ref } = ctx;
    if (!ticket.requesterEmail) return;
    const settings = await this.prisma.serviceSettings.findUnique({
      where: { organizationId: ticket.organizationId },
      select: { autoAcknowledge: true },
    });
    if (!settings?.autoAcknowledge) return;
    const html: string = await this.renderer.render(
      TicketAcknowledgementEmail({
        recipientName: ticket.requesterName ?? "",
        workspaceName: ctx.workspaceName,
        ticketRef: ref,
        subject: ticket.subject,
        ticketUrl: this.portalUrl(ticket),
        reference: ctx.reference,
        canReplyByEmail: !!ctx.replyTo,
      }),
    );
    await this.mail.send(ticket.requesterEmail, `[${ref}] ${ticket.subject}`, html, ticket.organizationId, {
      replyTo: ctx.replyTo ?? undefined,
      headers: {
        ...(await this.threadHeaders(ticket, outboundMessageId(ticket.emailToken, ctx.domain))),
        "Auto-Submitted": "auto-replied",
      },
    });
  }

  private portalUrl(ticket: TicketRow): string | null {
    return ticket.requesterUserId ? `${this.webUrl}/portal/tickets/${ticket.id}` : null;
  }

  /** Message-ID plus In-Reply-To/References pointing at the ticket's last emailed message, so clients thread. */
  private async threadHeaders(ticket: TicketRow, messageId: string): Promise<Record<string, string>> {
    const previous = await this.prisma.ticketMessage.findMany({
      where: { ticketId: ticket.id, emailMessageId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { emailMessageId: true },
    });
    const ids: string[] = previous.map((m) => `<${m.emailMessageId}>`).filter((id) => id !== `<${messageId}>`).reverse();
    return {
      "Message-ID": `<${messageId}>`,
      ...(ids.length > 0 ? { "In-Reply-To": ids[ids.length - 1], References: ids.join(" ") } : {}),
    };
  }

  private async context(ticketId: string): Promise<TicketContext | null> {
    const ticket: TicketRow | null = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: TICKET_SELECT });
    if (!ticket) return null;
    const [settings, org] = await Promise.all([
      this.prisma.serviceSettings.findUnique({
        where: { organizationId: ticket.organizationId },
        select: { ticketPrefix: true, inboundAddress: true, inboundMode: true },
      }),
      this.prisma.organization.findUnique({ where: { id: ticket.organizationId }, select: { name: true } }),
    ]);
    const prefix: string = settings?.ticketPrefix ?? "TKT";
    const ref: string = formatReference(prefix, ticket.number);
    const inbound: boolean = !!settings?.inboundAddress && settings.inboundMode !== "none";
    const replyTo: string | null = inbound ? plusAddress(settings?.inboundAddress, ticket.emailToken) : null;
    const domain: string = settings?.inboundAddress?.split("@")[1] ?? "atrium.invalid";
    return {
      ticket,
      ref,
      reference: `[${ref}:${ticket.emailToken}]`,
      replyTo,
      domain,
      workspaceName: org?.name ?? "our team",
    };
  }

  /** Owners/admins (with name and email), or only the given users when they are still staff. */
  private async staffRecipients(
    organizationId: string,
    only: string[] | null,
  ): Promise<{ userId: string; name: string; email: string }[]> {
    const members = await this.prisma.member.findMany({
      where: { organizationId, role: { in: ["owner", "admin"] }, ...(only ? { userId: { in: only } } : {}) },
      select: { userId: true, user: { select: { name: true, email: true } } },
    });
    if (only && members.length === 0) return this.staffRecipients(organizationId, null);
    return members.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email }));
  }

  private inAppAndPush(userIds: string[], organizationId: string, type: string, title: string, message: string, link: string): void {
    if (userIds.length === 0) return;
    this.inApp
      .createMany(userIds.map((userId) => ({ userId, organizationId, type, title, message, link })))
      .catch((err: unknown) => this.logger.warn({ err }, "Failed to create ticket in-app notifications"));
    this.push
      .sendToMany(userIds, organizationId, { title, message, link })
      .catch((err: unknown) => this.logger.warn({ err }, "Failed to send ticket push notifications"));
  }

  private dispatch(
    event: IntegrationEvent,
    ticket: TicketRow,
    title: string,
    actorName?: string,
    detail?: string,
    data?: Record<string, unknown>,
  ): void {
    this.integrations.dispatch({
      event,
      organizationId: ticket.organizationId,
      projectId: ticket.projectId,
      actorName,
      title,
      detail: detail ?? null,
      data: { ticketId: ticket.id, number: ticket.number, subject: ticket.subject, status: ticket.status, priority: ticket.priority, ...data },
      path: `/dashboard/tickets/${ticket.id}`,
    });
  }
}

interface TicketContext {
  ticket: TicketRow;
  ref: string;
  reference: string;
  replyTo: string | null;
  domain: string;
  workspaceName: string;
}
