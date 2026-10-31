import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { Ticket } from "@atrium/database";
import { PrismaService } from "../../prisma/prisma.service";
import { SettingsService } from "../../settings/settings.service";
import { AttachmentStorageService, AuditService, ServiceSettingsService } from "../../service-core";
import { TicketsService, type TicketActor } from "../tickets.service";
import { OUTBOUND_ID_TOKEN } from "../helpdesk-notifications.service";
import {
  displayName,
  findTicketToken,
  headerMap,
  htmlToText,
  isAutomatedEmail,
  normalizeAddress,
  parseMessageIds,
  stripAngles,
  stripQuotedReply,
  verifySignature,
  type ParsedEmail,
} from "./email-parsing";

const MAX_ATTACHMENTS = 10;
const MAX_BODY_CHARS = 50_000;

export type InboundStatus = "ticket_created" | "reply_added" | "triaged" | "ignored" | "failed" | "duplicate";

/**
 * Turns received email into tickets and replies. Shared by the signed webhook
 * and the IMAP poller. Unknown senders only ever produce triage tickets: no
 * user, member or portal login is created from an email.
 */
@Injectable()
export class InboundEmailService {
  private readonly logger = new Logger(InboundEmailService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private serviceSettings: ServiceSettingsService,
    private tickets: TicketsService,
    private attachments: AttachmentStorageService,
    private audit: AuditService,
  ) {}

  /** Webhook entry: resolves the workspace by slug and checks the HMAC signature before parsing anything. */
  async receiveWebhook(
    orgSlug: string,
    rawBody: Buffer | undefined,
    signature: string | undefined,
    timestamp: string | undefined,
  ): Promise<{ status: InboundStatus; ticketId: string | null }> {
    const org = await this.prisma.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } });
    // Unknown workspace and bad signature look the same to the caller.
    if (!org) throw new UnauthorizedException("Invalid signature");
    const s = await this.prisma.serviceSettings.findUnique({ where: { organizationId: org.id } });
    if (!s || s.inboundMode !== "webhook" || !s.inboundWebhookSecret) throw new UnauthorizedException("Invalid signature");
    if (!rawBody) throw new BadRequestException("Missing body");
    let secret: string;
    try {
      secret = this.settings.decrypt(s.inboundWebhookSecret);
    } catch {
      throw new UnauthorizedException("Invalid signature");
    }
    if (!verifySignature(secret, rawBody, signature, timestamp)) throw new UnauthorizedException("Invalid signature");
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Body must be JSON");
    }
    const email: ParsedEmail = await this.fromJson(payload);
    return this.process(org.id, email);
  }

  /** Generic JSON payload, or `{ "raw": "<base64 RFC 822 message>" }`. */
  async fromJson(payload: unknown): Promise<ParsedEmail> {
    if (!payload || typeof payload !== "object") throw new BadRequestException("Invalid payload");
    const p = payload as Record<string, unknown>;
    if (typeof p.raw === "string") return this.fromRaw(Buffer.from(p.raw, "base64"));
    const from: string | null = normalizeAddress(str(p.from));
    if (!from) throw new BadRequestException("Missing or invalid from address");
    const toList: string[] = (Array.isArray(p.to) ? p.to : [p.to]).map((t) => normalizeAddress(str(t))).filter((t): t is string => !!t);
    const headers: Record<string, string> = headerMap(p.headers);
    const text: string = str(p.text) || (str(p.html) ? htmlToText(str(p.html)) : "");
    const attachments: ParsedEmail["attachments"] = [];
    if (Array.isArray(p.attachments)) {
      for (const a of p.attachments.slice(0, MAX_ATTACHMENTS)) {
        if (!a || typeof a !== "object") continue;
        const att = a as Record<string, unknown>;
        const content: string = str(att.content) || str(att.contentBase64);
        if (!content) continue;
        attachments.push({
          filename: (str(att.filename) || "attachment").slice(0, 200),
          contentType: (str(att.contentType) || "application/octet-stream").slice(0, 200),
          content: Buffer.from(content, "base64"),
        });
      }
    }
    return {
      messageId: stripAngles(str(p.messageId) || headers["message-id"] || `generated-${randomBytes(12).toString("hex")}`).slice(0, 500),
      fromEmail: from,
      fromName: (str(p.fromName) || displayName(str(p.from)))?.slice(0, 200) || null,
      to: toList,
      subject: (str(p.subject) || "(no subject)").slice(0, 500),
      text: text.slice(0, MAX_BODY_CHARS * 2),
      inReplyTo: parseMessageIds(str(p.inReplyTo) || headers["in-reply-to"])[0] ?? null,
      references: parseMessageIds(Array.isArray(p.references) ? (p.references as string[]) : str(p.references) || headers["references"]),
      headers,
      attachments,
    };
  }

  async fromRaw(source: Buffer): Promise<ParsedEmail> {
    const mail: ParsedMail = await simpleParser(source, { skipHtmlToText: false, skipTextLinks: true });
    const from = mail.from?.value?.[0];
    const fromEmail: string | null = normalizeAddress(from?.address);
    if (!fromEmail) throw new BadRequestException("Missing from address");
    const toObjects: AddressObject[] = [mail.to, mail.cc].flat().filter((x): x is AddressObject => !!x);
    const to: string[] = toObjects.flatMap((o) => o.value.map((v) => normalizeAddress(v.address))).filter((x): x is string => !!x);
    const headers: Record<string, string> = {};
    for (const [k, v] of mail.headers) {
      headers[k.toLowerCase()] = (typeof v === "string" ? v : typeof v === "object" && v && "value" in v ? String((v as { value: unknown }).value) : String(v)).slice(0, 2000);
    }
    return {
      messageId: stripAngles(mail.messageId ?? `generated-${randomBytes(12).toString("hex")}`).slice(0, 500),
      fromEmail,
      fromName: from?.name?.slice(0, 200) || null,
      to,
      subject: (mail.subject ?? "(no subject)").slice(0, 500),
      text: (mail.text ?? (typeof mail.html === "string" ? htmlToText(mail.html) : "")).slice(0, MAX_BODY_CHARS * 2),
      inReplyTo: parseMessageIds(mail.inReplyTo)[0] ?? null,
      references: parseMessageIds(mail.references),
      headers,
      attachments: (mail.attachments ?? [])
        .filter((a) => a.contentDisposition !== "inline" || !a.contentId)
        .slice(0, MAX_ATTACHMENTS)
        .map((a) => ({ filename: (a.filename ?? "attachment").slice(0, 200), contentType: a.contentType, content: a.content })),
    };
  }

  async process(organizationId: string, email: ParsedEmail): Promise<{ status: InboundStatus; ticketId: string | null }> {
    // Idempotency: the (workspace, Message-ID) row is claimed before anything else happens.
    let logId: string;
    try {
      const row = await this.prisma.inboundEmail.create({
        data: {
          organizationId,
          messageId: email.messageId,
          fromEmail: email.fromEmail,
          fromName: email.fromName,
          subject: email.subject.slice(0, 500),
          status: "failed",
          error: "processing",
        },
      });
      logId = row.id;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") return { status: "duplicate", ticketId: null };
      throw err;
    }
    const finish = async (status: Exclude<InboundStatus, "duplicate">, ticketId: string | null, error: string | null = null) => {
      await this.prisma.inboundEmail.update({ where: { id: logId }, data: { status, ticketId, error } });
      return { status, ticketId };
    };
    try {
      if (isAutomatedEmail(email.headers, email.fromEmail)) return await finish("ignored", null, "automated message");
      const settings = await this.serviceSettings.get(organizationId);
      // Mail from our own inbound address would loop.
      if (settings.inboundAddress && email.fromEmail === settings.inboundAddress.toLowerCase()) {
        return await finish("ignored", null, "sent from the inbound address");
      }
      const existing: Ticket | null = await this.findThread(organizationId, email, settings.ticketPrefix);
      if (existing) return await this.reply(existing, email, finish);
      return await this.newTicket(organizationId, email, finish);
    } catch (err) {
      this.logger.error(`Inbound email ${logId} failed`, err instanceof Error ? err.stack : String(err));
      return finish("failed", null, err instanceof Error ? err.message.slice(0, 500) : "error");
    }
  }

  /** In-Reply-To/References against stored message ids first, then the ticket token. Follows merges. */
  async findThread(organizationId: string, email: ParsedEmail, prefix: string): Promise<Ticket | null> {
    const ids: string[] = [...(email.inReplyTo ? [email.inReplyTo] : []), ...email.references].slice(0, 50);
    let ticket: Ticket | null = null;
    if (ids.length > 0) {
      const message = await this.prisma.ticketMessage.findFirst({
        where: { organizationId, emailMessageId: { in: ids } },
        orderBy: { createdAt: "desc" },
        select: { ticketId: true },
      });
      if (message) ticket = await this.prisma.ticket.findFirst({ where: { id: message.ticketId, organizationId } });
      if (!ticket) {
        for (const id of ids) {
          const m = OUTBOUND_ID_TOKEN.exec(id);
          if (m) {
            ticket = await this.prisma.ticket.findFirst({ where: { emailToken: m[1], organizationId } });
            if (ticket) break;
          }
        }
      }
    }
    if (!ticket) {
      const token: string | null = findTicketToken(email, prefix);
      if (token) ticket = await this.prisma.ticket.findFirst({ where: { emailToken: token, organizationId } });
    }
    for (let i = 0; ticket?.mergedIntoId && i < 5; i++) {
      ticket = await this.prisma.ticket.findFirst({ where: { id: ticket.mergedIntoId, organizationId } });
    }
    return ticket;
  }

  private async reply(
    ticket: Ticket,
    email: ParsedEmail,
    finish: (status: Exclude<InboundStatus, "duplicate">, ticketId: string | null, error?: string | null) => Promise<{ status: InboundStatus; ticketId: string | null }>,
  ) {
    const orgId: string = ticket.organizationId;
    const body: string = stripQuotedReply(email.text).slice(0, MAX_BODY_CHARS) || "(empty message)";
    const sender = await this.identify(orgId, email.fromEmail);
    const isRequester: boolean = email.fromEmail === ticket.requesterEmail;
    const sameCompany: boolean = !!sender.contact?.companyId && sender.contact.companyId === ticket.companyId;
    const author: TicketActor = {
      userId: sender.portalUserId ?? sender.staffUserId,
      name: sender.contact?.name ?? email.fromName ?? email.fromEmail,
      email: email.fromEmail,
    };
    if (ticket.status === "closed") {
      // A closed ticket stays closed; the follow-up becomes a new ticket linked to it.
      const result = await this.newTicket(orgId, email, finish, ticket);
      return result;
    }
    let messageId: string;
    if (sender.staffUserId) {
      const message = await this.prisma.ticketMessage.create({
        data: { ticketId: ticket.id, organizationId: orgId, authorUserId: sender.staffUserId, authorName: author.name, authorEmail: email.fromEmail, visibility: "internal", body, source: "email", emailMessageId: email.messageId, inReplyTo: email.inReplyTo },
      });
      messageId = message.id;
    } else if (isRequester || sameCompany) {
      const message = await this.tickets.addClientMessage(ticket, author, body, "email", { messageId: email.messageId, inReplyTo: email.inReplyTo });
      messageId = message.id;
    } else {
      // Someone else replied on the thread (a CC, a forward): staff decide whether it belongs.
      const message = await this.prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          organizationId: orgId,
          authorName: author.name,
          authorEmail: email.fromEmail,
          visibility: "internal",
          body: `Email from ${email.fromEmail} (not the requester):\n\n${body}`,
          source: "email",
          emailMessageId: email.messageId,
          inReplyTo: email.inReplyTo,
        },
      });
      messageId = message.id;
    }
    await this.saveAttachments(ticket, messageId, email);
    return finish("reply_added", ticket.id);
  }

  private async newTicket(
    organizationId: string,
    email: ParsedEmail,
    finish: (status: Exclude<InboundStatus, "duplicate">, ticketId: string | null, error?: string | null) => Promise<{ status: InboundStatus; ticketId: string | null }>,
    followUpOf?: Ticket,
  ) {
    const sender = await this.identify(organizationId, email.fromEmail);
    if (sender.staffUserId && !sender.contact) {
      return finish("ignored", null, "staff email that is not a reply to a ticket");
    }
    const known: boolean = !!sender.contact;
    const body: string = stripQuotedReply(email.text).slice(0, MAX_BODY_CHARS) || "(empty message)";
    const subject: string = email.subject.replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim() || "(no subject)";
    const ticket: Ticket = await this.tickets.createTicket({
      organizationId,
      subject,
      body,
      source: "email",
      companyId: sender.contact?.companyId ?? null,
      requesterUserId: sender.portalUserId,
      requesterContactId: sender.contact?.id ?? null,
      requesterEmail: email.fromEmail,
      requesterName: sender.contact?.name ?? email.fromName,
      triage: !known,
      author: { userId: sender.portalUserId, name: sender.contact?.name ?? email.fromName ?? email.fromEmail, email: email.fromEmail },
      messageSource: "email",
      emailMessageId: email.messageId,
      inReplyTo: email.inReplyTo,
      acknowledge: known,
    });
    if (followUpOf) {
      await this.prisma.ticketLink.create({ data: { ticketId: ticket.id, relatedTicketId: followUpOf.id, type: "related" } }).catch(() => undefined);
    }
    const first = await this.prisma.ticketMessage.findFirst({ where: { ticketId: ticket.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (first) await this.saveAttachments(ticket, first.id, email);
    if (!known) {
      await this.audit.record({
        organizationId,
        action: "ticket.triaged",
        actorEmail: email.fromEmail,
        targetType: "ticket",
        targetId: ticket.id,
        summary: `Email from unknown sender ${email.fromEmail} sent to triage`,
      });
    }
    return finish(known ? "ticket_created" : "triaged", ticket.id);
  }

  /** Who sent this, as far as this workspace knows: a contact (maybe with a portal login) and/or a staff member. */
  private async identify(organizationId: string, fromEmail: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { organizationId, email: fromEmail },
      select: { id: true, name: true, companyId: true, userId: true },
    });
    let portalUserId: string | null = null;
    if (contact?.userId) {
      const member = await this.prisma.member.findFirst({ where: { organizationId, userId: contact.userId }, select: { role: true } });
      if (member) portalUserId = contact.userId;
    }
    const staff = await this.prisma.member.findFirst({
      where: { organizationId, role: { in: ["owner", "admin"] }, user: { email: fromEmail } },
      select: { userId: true },
    });
    return { contact, portalUserId, staffUserId: staff?.userId ?? null };
  }

  private async saveAttachments(ticket: Ticket, messageId: string, email: ParsedEmail): Promise<void> {
    const skipped: string[] = [];
    for (const att of email.attachments) {
      const path: string = join(tmpdir(), `atrium-inbound-${randomBytes(12).toString("hex")}`);
      try {
        await writeFile(path, att.content, { mode: 0o600 });
        const stored = await this.attachments.store(
          { path, originalname: att.filename, mimetype: att.contentType, size: att.content.length },
          ticket.organizationId,
          `tickets/${ticket.id}`,
        );
        await this.prisma.ticketAttachment.create({
          data: {
            ticketId: ticket.id,
            messageId,
            organizationId: ticket.organizationId,
            storageKey: stored.storageKey,
            filename: stored.filename,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            scanStatus: stored.scanStatus,
          },
        });
      } catch (err) {
        skipped.push(`${att.filename}: ${err instanceof Error ? err.message : "rejected"}`);
      } finally {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
    if (skipped.length > 0) {
      await this.prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          organizationId: ticket.organizationId,
          visibility: "internal",
          source: "system",
          body: `Some email attachments were not saved:\n\n${skipped.map((s) => `- ${s}`).join("\n")}`,
        },
      });
    }
  }

  /** For tests and the staff "recent inbound" list. */
  async recent(organizationId: string, limit = 20) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!org) throw new NotFoundException();
    return this.prisma.inboundEmail.findMany({ where: { organizationId }, orderBy: { receivedAt: "desc" }, take: limit });
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
