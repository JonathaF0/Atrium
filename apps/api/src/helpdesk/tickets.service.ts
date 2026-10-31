import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import type { Prisma, Ticket } from "@atrium/database";
import {
  TICKET_PRIORITIES,
  priorityFromImpact,
  type TicketLevel,
  type TicketSource,
  type TicketStatus,
} from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { assertProjectAccess, paginatedResponse, paginationArgs } from "../common";
import type { TempUploadedFile } from "../files/files.service";
import {
  AttachmentStorageService,
  AuditService,
  ClientScopeService,
  ServiceSettingsService,
  clientCanSee,
  clientOwnedWhere,
  formatReference,
  normalizeMarkdown,
} from "../service-core";
import type { AuditRequestContext, ClientScope } from "../service-core";
import { auditContext } from "../service-core";
import { HelpdeskDefaultsService } from "./helpdesk-defaults.service";
import { HelpdeskNotificationsService } from "./helpdesk-notifications.service";
import { SlaService } from "./sla.service";
import { AutomationService } from "./automation.service";
import { ACTIVE_STATUSES, clientMay, isDone, statusAfterClientReply, statusSideEffects } from "./ticket-status";
import type {
  AcceptTriageDto,
  CreatePortalTicketDto,
  CreateStaffTicketDto,
  CsatDto,
  PortalTicketQueryDto,
  StaffReplyDto,
  StaffTicketQueryDto,
  UpdateTicketDto,
} from "./helpdesk.dto";

/** Who is acting: a staff member, a client, or the system (crons, automation, inbound email). */
export interface TicketActor {
  userId: string | null;
  name: string | null;
  email?: string | null;
}

export interface NewTicketInput {
  organizationId: string;
  subject: string;
  body: string;
  source: TicketSource;
  priority?: string | null;
  impact?: TicketLevel | null;
  urgency?: TicketLevel | null;
  categoryId?: string | null;
  companyId?: string | null;
  requesterUserId?: string | null;
  requesterContactId?: string | null;
  requesterEmail?: string | null;
  requesterName?: string | null;
  assigneeId?: string | null;
  projectId?: string | null;
  assetId?: string | null;
  taskId?: string | null;
  triage?: boolean;
  /** Author of the first message. */
  author: TicketActor;
  messageSource?: string;
  emailMessageId?: string | null;
  inReplyTo?: string | null;
  acknowledge: boolean;
}

export interface TicketChanges {
  status?: TicketStatus;
  priority?: string;
  subject?: string;
  categoryId?: string | null;
  assigneeId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
}

/** How a change was made, for the event log and for what gets notified. */
export interface ChangeOptions {
  /** Tell the requester about status changes. */
  notifyRequester: boolean;
  /** Recorded on the events, e.g. the automation rule's name. */
  via?: string;
  /** Skip running ticket_updated automation rules (automation's own changes, bulk, crons). */
  skipAutomation?: boolean;
  note?: string;
}

const MESSAGE_SELECT = {
  id: true,
  authorUserId: true,
  authorName: true,
  authorEmail: true,
  visibility: true,
  body: true,
  source: true,
  createdAt: true,
  attachments: {
    select: { id: true, filename: true, mimeType: true, sizeBytes: true, scanStatus: true, createdAt: true },
  },
} as const;

const LIST_SELECT = {
  id: true,
  number: true,
  subject: true,
  status: true,
  priority: true,
  source: true,
  triage: true,
  createdAt: true,
  updatedAt: true,
  lastActivityAt: true,
  requesterName: true,
  requesterEmail: true,
  requesterUserId: true,
  assigneeId: true,
  firstRespondedAt: true,
  firstResponseDueAt: true,
  resolutionDueAt: true,
  firstResponseBreached: true,
  resolutionBreached: true,
  slaPausedAt: true,
  slaWarnedAt: true,
  mergedIntoId: true,
  category: { select: { id: true, name: true, color: true } },
  company: { select: { id: true, name: true } },
  labels: { select: { label: { select: { id: true, name: true, color: true } } } },
} as const;

const SLA_RISK_WINDOW_MS = 60 * 60_000;

export function newEmailToken(): string {
  return randomBytes(18).toString("base64url");
}

export function parseTicketQuery(q: string, prefix: string): { number: number | null; text: string } {
  const text: string = q.trim();
  const m = new RegExp(`^(?:${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-?)?#?(\\d{1,9})$`, "i").exec(text);
  return { number: m ? Number(m[1]) : null, text };
}

/** Where-clause for a staff queue view. */
export function queueViewWhere(view: string, userId: string, now: Date): Prisma.TicketWhereInput {
  const active: Prisma.TicketWhereInput = { status: { in: ACTIVE_STATUSES } };
  switch (view) {
    case "unassigned":
      return { ...active, assigneeId: null };
    case "mine":
      return { ...active, assigneeId: userId };
    case "triage":
      return { ...active, triage: true };
    case "sla_risk": {
      const soon = new Date(now.getTime() + SLA_RISK_WINDOW_MS);
      return {
        ...active,
        slaPausedAt: null,
        OR: [
          { firstResponseBreached: true },
          { resolutionBreached: true },
          { slaWarnedAt: { not: null } },
          { firstRespondedAt: null, firstResponseDueAt: { lte: soon } },
          { resolutionDueAt: { lte: soon } },
        ],
      };
    }
    case "closed":
      return { status: { in: ["resolved", "closed"] } };
    case "all":
      return {};
    case "open":
    default:
      return active;
  }
}

@Injectable()
export class TicketsService {
  constructor(
    private prisma: PrismaService,
    private serviceSettings: ServiceSettingsService,
    private clientScope: ClientScopeService,
    private attachments: AttachmentStorageService,
    private audit: AuditService,
    private defaults: HelpdeskDefaultsService,
    private sla: SlaService,
    private notifications: HelpdeskNotificationsService,
    private automation: AutomationService,
  ) {}

  // ─── Creation ───

  async createTicket(input: NewTicketInput): Promise<Ticket> {
    const orgId: string = input.organizationId;
    await this.defaults.ensure(orgId);
    const settings = await this.serviceSettings.get(orgId);

    let category: { id: string; defaultPriority: string; defaultAssigneeId: string | null } | null = null;
    if (input.categoryId) {
      category = await this.prisma.ticketCategory.findFirst({
        where: { id: input.categoryId, organizationId: orgId, archivedAt: null },
        select: { id: true, defaultPriority: true, defaultAssigneeId: true },
      });
      if (!category) throw new BadRequestException("Unknown category");
    }

    let priority: string = category?.defaultPriority ?? "normal";
    if (input.impact && input.urgency) priority = priorityFromImpact(input.impact, input.urgency);
    else if (input.priority) priority = input.priority;
    if (!(TICKET_PRIORITIES as readonly string[]).includes(priority)) priority = "normal";

    let assigneeId: string | null =
      input.assigneeId ?? category?.defaultAssigneeId ?? (input.triage ? settings.triageAssigneeId : null) ?? null;
    if (assigneeId && !(await this.isStaff(orgId, assigneeId))) {
      if (input.assigneeId) throw new BadRequestException("Assignee must be an owner or admin of this workspace");
      assigneeId = null;
    }

    const body: string = normalizeMarkdown(input.body);
    const subject: string = input.subject.trim().replace(/\s+/g, " ").slice(0, 200);
    const now = new Date();

    const ticket: Ticket = await this.prisma.$transaction(async (tx) => {
      const { number } = await this.serviceSettings.nextNumber(orgId, "ticket", tx);
      const slaFields = await this.sla.initial(orgId, category?.id ?? null, input.companyId ?? null, priority, now, tx);
      const created = await tx.ticket.create({
        data: {
          organizationId: orgId,
          number,
          subject,
          status: "new",
          priority,
          impact: input.impact ?? null,
          urgency: input.urgency ?? null,
          source: input.source,
          categoryId: category?.id ?? null,
          companyId: input.companyId ?? null,
          requesterContactId: input.requesterContactId ?? null,
          requesterUserId: input.requesterUserId ?? null,
          requesterEmail: input.requesterEmail?.toLowerCase() ?? null,
          requesterName: input.requesterName ?? null,
          assigneeId,
          projectId: input.projectId ?? null,
          assetId: input.assetId ?? null,
          taskId: input.taskId ?? null,
          triage: input.triage ?? false,
          emailToken: newEmailToken(),
          lastActivityAt: now,
          createdAt: now,
          ...slaFields,
        },
      });
      await tx.ticketMessage.create({
        data: {
          ticketId: created.id,
          organizationId: orgId,
          authorUserId: input.author.userId,
          authorName: input.author.name,
          authorEmail: input.author.email ?? null,
          visibility: "public",
          body: body || "(no description)",
          source: input.messageSource ?? input.source,
          emailMessageId: input.emailMessageId ?? null,
          inReplyTo: input.inReplyTo ?? null,
          createdAt: now,
        },
      });
      if (input.assetId) {
        await tx.ticketAsset.create({ data: { ticketId: created.id, assetId: input.assetId } });
      }
      await tx.ticketEvent.create({
        data: { ticketId: created.id, actorId: input.author.userId, type: "created", toValue: input.source },
      });
      return created;
    });

    const after: Ticket = await this.runAutomation("ticket_created", ticket);
    this.notifications.ticketCreated(after.id, { acknowledge: input.acknowledge });
    if (after.assigneeId && after.assigneeId !== input.author.userId) {
      this.notifications.assigned(after.id, after.assigneeId, input.author.userId);
    }
    return after;
  }

  async createForClient(userId: string, role: string, orgId: string, dto: CreatePortalTicketDto) {
    const scope: ClientScope = await this.clientScope.resolve(userId, orgId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    if (!user) throw new ForbiddenException();
    if (dto.categoryId) {
      const visible = await this.prisma.ticketCategory.count({
        where: { id: dto.categoryId, organizationId: orgId, portalVisible: true, archivedAt: null },
      });
      if (!visible) throw new BadRequestException("Unknown category");
    }
    if (dto.projectId) {
      // assertProjectAccess skips owners and admins entirely, so check the workspace here.
      const project = await this.prisma.project.findFirst({ where: { id: dto.projectId, organizationId: orgId }, select: { id: true } });
      if (!project) throw new BadRequestException("Unknown project");
      await assertProjectAccess(this.prisma, dto.projectId, userId, role, orgId);
    }
    if (dto.assetId) {
      const asset = await this.prisma.asset.findFirst({
        where: { id: dto.assetId, organizationId: orgId, clientVisible: true, companyId: scope.companyId ?? "__none__" },
        select: { id: true },
      });
      if (!asset) throw new BadRequestException("Unknown asset");
    }
    const ticket: Ticket = await this.createTicket({
      organizationId: orgId,
      subject: dto.subject,
      body: dto.description,
      source: "portal",
      priority: dto.priority,
      impact: dto.impact,
      urgency: dto.urgency,
      categoryId: dto.categoryId,
      companyId: scope.companyId,
      requesterUserId: userId,
      requesterContactId: scope.contactId,
      requesterEmail: scope.email ?? user.email,
      requesterName: scope.name ?? user.name,
      projectId: dto.projectId,
      assetId: dto.assetId,
      author: { userId, name: user.name, email: user.email },
      acknowledge: true,
    });
    return this.findOneForClient(ticket.id, userId, orgId);
  }

  async createForStaff(orgId: string, actor: TicketActor, dto: CreateStaffTicketDto) {
    let requester: {
      contactId: string | null;
      userId: string | null;
      companyId: string | null;
      email: string | null;
      name: string | null;
    } = { contactId: null, userId: null, companyId: dto.companyId ?? null, email: dto.requesterEmail?.toLowerCase() ?? null, name: dto.requesterName ?? null };
    const contact = dto.contactId
      ? await this.prisma.contact.findFirst({ where: { id: dto.contactId, organizationId: orgId } })
      : requester.email
        ? await this.prisma.contact.findFirst({ where: { email: requester.email, organizationId: orgId } })
        : null;
    if (dto.contactId && !contact) throw new BadRequestException("Unknown contact");
    if (contact) {
      requester = {
        contactId: contact.id,
        userId: contact.userId && (await this.isMember(orgId, contact.userId)) ? contact.userId : null,
        companyId: contact.companyId ?? requester.companyId,
        email: contact.email ?? requester.email,
        name: contact.name,
      };
    }
    if (!requester.email && !requester.contactId) throw new BadRequestException("A contact or requester email is required");
    if (requester.companyId) await this.assertCompany(orgId, requester.companyId);
    if (dto.projectId) await this.assertProject(orgId, dto.projectId);
    const ticket: Ticket = await this.createTicket({
      organizationId: orgId,
      subject: dto.subject,
      body: dto.description,
      source: "staff",
      priority: dto.priority,
      impact: dto.impact,
      urgency: dto.urgency,
      categoryId: dto.categoryId,
      companyId: requester.companyId,
      requesterUserId: requester.userId,
      requesterContactId: requester.contactId,
      requesterEmail: requester.email,
      requesterName: requester.name,
      assigneeId: dto.assigneeId,
      projectId: dto.projectId,
      author: actor,
      messageSource: "staff",
      acknowledge: false,
    });
    return ticket;
  }

  // ─── Portal ───

  async listForClient(userId: string, orgId: string, query: PortalTicketQueryDto) {
    const scope: ClientScope = await this.clientScope.resolve(userId, orgId);
    const page: number = query.page ?? 1;
    const limit: number = query.limit ?? 20;
    const owned = query.scope === "mine" ? { requesterUserId: userId } : clientOwnedWhere(scope, "requesterUserId");
    const where: Prisma.TicketWhereInput = {
      organizationId: orgId,
      AND: [
        owned,
        query.status === "active"
          ? { status: { in: ACTIVE_STATUSES } }
          : query.status === "done"
            ? { status: { in: ["resolved", "closed"] } }
            : query.status
              ? { status: query.status }
              : {},
        query.q ? { subject: { contains: query.q, mode: "insensitive" } } : {},
      ],
    };
    const prefix: string = (await this.serviceSettings.get(orgId)).ticketPrefix;
    const [rows, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: { lastActivityAt: "desc" },
        ...paginationArgs(page, limit),
        select: {
          id: true,
          number: true,
          subject: true,
          status: true,
          priority: true,
          createdAt: true,
          lastActivityAt: true,
          requesterName: true,
          requesterUserId: true,
          category: { select: { id: true, name: true, color: true } },
        },
      }),
      this.prisma.ticket.count({ where }),
    ]);
    const data = rows.map((t) => ({ ...t, reference: formatReference(prefix, t.number), own: t.requesterUserId === userId }));
    return { ...paginatedResponse(data, total, page, limit), companyAdmin: scope.companyAdmin };
  }

  private async loadForClient(id: string, userId: string, orgId: string): Promise<{ ticket: Ticket; scope: ClientScope }> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, organizationId: orgId } });
    if (!ticket) throw new NotFoundException("Ticket not found");
    const scope: ClientScope = await this.clientScope.resolve(userId, orgId);
    if (!clientCanSee(scope, ticket.requesterUserId, ticket.companyId)) throw new NotFoundException("Ticket not found");
    return { ticket, scope };
  }

  async findOneForClient(id: string, userId: string, orgId: string) {
    const { ticket } = await this.loadForClient(id, userId, orgId);
    const settings = await this.serviceSettings.get(orgId);
    const [messages, events, category, assignee] = await Promise.all([
      this.prisma.ticketMessage.findMany({
        where: { ticketId: id, visibility: "public" },
        orderBy: { createdAt: "asc" },
        select: MESSAGE_SELECT,
      }),
      this.prisma.ticketEvent.findMany({
        where: { ticketId: id, type: { in: ["created", "status"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, type: true, fromValue: true, toValue: true, createdAt: true },
      }),
      ticket.categoryId
        ? this.prisma.ticketCategory.findUnique({ where: { id: ticket.categoryId }, select: { id: true, name: true, color: true } })
        : null,
      ticket.assigneeId ? this.prisma.user.findUnique({ where: { id: ticket.assigneeId }, select: { name: true } }) : null,
    ]);
    return {
      id: ticket.id,
      number: ticket.number,
      reference: formatReference(settings.ticketPrefix, ticket.number),
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      createdAt: ticket.createdAt,
      lastActivityAt: ticket.lastActivityAt,
      resolvedAt: ticket.resolvedAt,
      closedAt: ticket.closedAt,
      requesterName: ticket.requesterName,
      own: ticket.requesterUserId === userId,
      category,
      assigneeName: assignee?.name ?? null,
      mergedIntoId: ticket.mergedIntoId,
      csatRating: ticket.csatRating,
      csatComment: ticket.csatComment,
      messages,
      events,
      can: {
        reply: clientMay("reply", ticket, settings),
        reopen: clientMay("reopen", ticket, settings),
        close: clientMay("close", ticket, settings),
        rate: clientMay("rate", ticket, settings),
      },
    };
  }

  async replyAsClient(id: string, userId: string, orgId: string, body: string) {
    const { ticket } = await this.loadForClient(id, userId, orgId);
    const settings = await this.serviceSettings.get(orgId);
    if (!clientMay("reply", ticket, settings)) throw new BadRequestException("This ticket can no longer be replied to");
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    const message = await this.addClientMessage(ticket, { userId, name: user?.name ?? null, email: user?.email ?? null }, body, "portal");
    return message;
  }

  /** Shared by the portal and inbound email: adds the reply and moves the ticket back to staff. */
  async addClientMessage(
    ticket: Ticket,
    author: TicketActor,
    body: string,
    source: string,
    email?: { messageId: string | null; inReplyTo: string | null },
  ) {
    const message = await this.prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        organizationId: ticket.organizationId,
        authorUserId: author.userId,
        authorName: author.name,
        authorEmail: author.email ?? null,
        visibility: "public",
        body: normalizeMarkdown(body) || "(no content)",
        source,
        emailMessageId: email?.messageId ?? null,
        inReplyTo: email?.inReplyTo ?? null,
      },
      select: MESSAGE_SELECT,
    });
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { lastActivityAt: new Date() } });
    const next: TicketStatus | null = statusAfterClientReply(ticket.status);
    if (next) {
      await this.changeTicket(ticket, { status: next }, author, { notifyRequester: false, via: "client reply", skipAutomation: true });
    }
    this.notifications.clientReplied(ticket.id, author.name ?? author.email ?? "Client", message.body);
    const fresh = await this.prisma.ticket.findUnique({ where: { id: ticket.id } });
    if (fresh) await this.runAutomation("ticket_updated", fresh);
    return message;
  }

  async reopenAsClient(id: string, userId: string, orgId: string) {
    const { ticket } = await this.loadForClient(id, userId, orgId);
    const settings = await this.serviceSettings.get(orgId);
    if (!clientMay("reopen", ticket, settings)) throw new BadRequestException("Only resolved tickets can be reopened");
    await this.changeTicket(ticket, { status: "open" }, await this.userActor(userId), { notifyRequester: false, via: "client" });
    return this.findOneForClient(id, userId, orgId);
  }

  async closeAsClient(id: string, userId: string, orgId: string) {
    const { ticket } = await this.loadForClient(id, userId, orgId);
    const settings = await this.serviceSettings.get(orgId);
    if (!clientMay("close", ticket, settings)) throw new ForbiddenException("This ticket cannot be closed");
    await this.changeTicket(ticket, { status: "closed" }, await this.userActor(userId), { notifyRequester: false, via: "client" });
    return this.findOneForClient(id, userId, orgId);
  }

  async rateAsClient(id: string, userId: string, orgId: string, dto: CsatDto) {
    const { ticket } = await this.loadForClient(id, userId, orgId);
    const settings = await this.serviceSettings.get(orgId);
    if (!clientMay("rate", ticket, settings)) throw new BadRequestException("This ticket cannot be rated yet");
    if (ticket.requesterUserId !== userId) throw new ForbiddenException("Only the requester can rate this ticket");
    await this.prisma.$transaction([
      this.prisma.ticket.update({
        where: { id },
        data: { csatRating: dto.rating, csatComment: dto.comment?.trim() || null, csatAt: new Date() },
      }),
      this.prisma.ticketEvent.create({ data: { ticketId: id, actorId: userId, type: "csat", toValue: String(dto.rating) } }),
    ]);
    return this.findOneForClient(id, userId, orgId);
  }

  async addClientAttachment(id: string, userId: string, orgId: string, messageId: string, file: TempUploadedFile) {
    const { ticket } = await this.loadForClient(id, userId, orgId);
    const message = await this.prisma.ticketMessage.findFirst({
      where: { id: messageId, ticketId: ticket.id, authorUserId: userId, visibility: "public" },
      select: { id: true, createdAt: true },
    });
    // Attachments follow the message they belong to; only fresh messages of your own take them.
    if (!message || Date.now() - message.createdAt.getTime() > 30 * 60_000) {
      throw new BadRequestException("Attachments can only be added to your latest message");
    }
    const count: number = await this.prisma.ticketAttachment.count({ where: { messageId } });
    if (count >= 10) throw new BadRequestException("A message can have at most 10 attachments");
    return this.storeAttachment(ticket, message.id, userId, file);
  }

  async downloadForClient(attachmentId: string, userId: string, orgId: string) {
    const attachment = await this.prisma.ticketAttachment.findFirst({
      where: { id: attachmentId, organizationId: orgId, message: { visibility: "public" } },
    });
    if (!attachment) throw new NotFoundException("Attachment not found");
    await this.loadForClient(attachment.ticketId, userId, orgId);
    return this.openAttachment(attachment);
  }

  // ─── Staff ───

  async list(orgId: string, userId: string, query: StaffTicketQueryDto) {
    await this.defaults.ensure(orgId);
    const page: number = query.page ?? 1;
    const limit: number = query.limit ?? 25;
    const prefix: string = (await this.serviceSettings.get(orgId)).ticketPrefix;
    const view: string = query.view ?? "open";
    const now = new Date();
    const and: Prisma.TicketWhereInput[] = [queueViewWhere(view, userId, now)];
    if (query.status) and.push({ status: query.status });
    if (query.priority) and.push({ priority: query.priority });
    if (query.categoryId) and.push({ categoryId: query.categoryId });
    if (query.companyId) and.push({ companyId: query.companyId });
    if (query.assigneeId) and.push({ assigneeId: query.assigneeId === "none" ? null : query.assigneeId });
    if (query.labelId) and.push({ labels: { some: { labelId: query.labelId } } });
    if (query.q) {
      const { number, text } = parseTicketQuery(query.q, prefix);
      and.push({
        OR: [
          { subject: { contains: text, mode: "insensitive" } },
          { requesterEmail: { contains: text.toLowerCase() } },
          ...(number !== null ? [{ number }] : []),
        ],
      });
    }
    const where: Prisma.TicketWhereInput = { organizationId: orgId, AND: and };
    const orderBy: Prisma.TicketOrderByWithRelationInput[] =
      view === "sla_risk" ? [{ resolutionDueAt: "asc" }] : [{ lastActivityAt: "desc" }];
    const [rows, total, counts] = await Promise.all([
      this.prisma.ticket.findMany({ where, orderBy, ...paginationArgs(page, limit), select: LIST_SELECT }),
      this.prisma.ticket.count({ where }),
      this.viewCounts(orgId, userId, now),
    ]);
    const names = await this.userNames(rows.map((r) => r.assigneeId));
    const data = rows.map(({ labels, ...t }) => ({
      ...t,
      reference: formatReference(prefix, t.number),
      assigneeName: t.assigneeId ? (names.get(t.assigneeId) ?? null) : null,
      labels: labels.map((l) => l.label),
    }));
    return { ...paginatedResponse(data, total, page, limit), counts };
  }

  private async viewCounts(orgId: string, userId: string, now: Date): Promise<Record<string, number>> {
    const views = ["open", "unassigned", "mine", "triage", "sla_risk"];
    const values: number[] = await Promise.all(
      views.map((v) => this.prisma.ticket.count({ where: { organizationId: orgId, ...queueViewWhere(v, userId, now) } })),
    );
    return Object.fromEntries(views.map((v, i) => [v, values[i]]));
  }

  async findOne(id: string, orgId: string) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, organizationId: orgId },
      include: {
        category: { select: { id: true, name: true, color: true } },
        company: { select: { id: true, name: true, hourlyRateCents: true } },
        slaPolicy: { select: { id: true, name: true, warnAtPercent: true } },
        mergedInto: { select: { id: true, number: true, subject: true } },
        mergedFrom: { select: { id: true, number: true, subject: true } },
        messages: { orderBy: { createdAt: "asc" }, select: { ...MESSAGE_SELECT, emailMessageId: true } },
        events: { orderBy: { createdAt: "asc" } },
        labels: { select: { label: { select: { id: true, name: true, color: true } } } },
        links: { select: { id: true, type: true, relatedTicket: { select: { id: true, number: true, subject: true, status: true } } } },
        linkedFrom: { select: { id: true, type: true, ticket: { select: { id: true, number: true, subject: true, status: true } } } },
        timeEntries: {
          orderBy: { startedAt: "desc" },
          select: {
            id: true,
            description: true,
            startedAt: true,
            endedAt: true,
            durationSec: true,
            billable: true,
            invoiceLineItemId: true,
            user: { select: { id: true, name: true } },
          },
        },
        assets: { select: { asset: { select: { id: true, name: true, type: true } } } },
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    const settings = await this.serviceSettings.get(orgId);
    const userIds: (string | null)[] = [ticket.assigneeId, ...ticket.events.map((e) => e.actorId)];
    const names = await this.userNames(userIds);
    const [contact, project, task] = await Promise.all([
      ticket.requesterContactId
        ? this.prisma.contact.findFirst({
            where: { id: ticket.requesterContactId, organizationId: orgId },
            select: { id: true, name: true, email: true, userId: true, companyAdmin: true },
          })
        : null,
      ticket.projectId ? this.prisma.project.findFirst({ where: { id: ticket.projectId, organizationId: orgId }, select: { id: true, name: true } }) : null,
      ticket.taskId ? this.prisma.task.findFirst({ where: { id: ticket.taskId, organizationId: orgId }, select: { id: true, title: true, projectId: true } }) : null,
    ]);
    const prefix: string = settings.ticketPrefix;
    const { labels, links, linkedFrom, events, assets, emailToken: _token, ...rest } = ticket;
    void _token;
    return {
      ...rest,
      reference: formatReference(prefix, ticket.number),
      assigneeName: ticket.assigneeId ? (names.get(ticket.assigneeId) ?? null) : null,
      contact,
      project,
      task,
      labels: labels.map((l) => l.label),
      assets: assets.map((a) => a.asset),
      events: events.map((e) => ({ ...e, actorName: e.actorId ? (names.get(e.actorId) ?? null) : null })),
      links: [
        ...links.map((l) => ({ id: l.id, type: l.type, direction: "out" as const, ticket: { ...l.relatedTicket, reference: formatReference(prefix, l.relatedTicket.number) } })),
        ...linkedFrom.map((l) => ({ id: l.id, type: l.type, direction: "in" as const, ticket: { ...l.ticket, reference: formatReference(prefix, l.ticket.number) } })),
      ],
      timeTotalSec: ticket.timeEntries.reduce((sum, e) => sum + (e.durationSec ?? 0), 0),
    };
  }

  async update(id: string, orgId: string, actor: TicketActor, dto: UpdateTicketDto) {
    const ticket = await this.getOrThrow(id, orgId);
    const changes: TicketChanges = {};
    if (dto.status !== undefined) changes.status = dto.status;
    if (dto.priority !== undefined) changes.priority = dto.priority;
    if (dto.subject !== undefined) changes.subject = dto.subject.trim();
    if (dto.categoryId !== undefined) changes.categoryId = dto.categoryId;
    if (dto.assigneeId !== undefined) changes.assigneeId = dto.assigneeId;
    if (dto.companyId !== undefined) changes.companyId = dto.companyId;
    if (dto.projectId !== undefined) changes.projectId = dto.projectId;
    await this.changeTicket(ticket, changes, actor, { notifyRequester: true });
    return this.findOne(id, orgId);
  }

  /**
   * The one place ticket fields change: validates references, writes the
   * update with status side effects and SLA adjustments, records an event per
   * field, notifies, and (unless told not to) runs ticket_updated automation.
   */
  async changeTicket(ticket: Ticket, changes: TicketChanges, actor: TicketActor, opts: ChangeOptions): Promise<Ticket> {
    const orgId: string = ticket.organizationId;
    const data: Prisma.TicketUncheckedUpdateInput = {};
    const events: { type: string; fromValue: string | null; toValue: string | null; detail?: string }[] = [];
    const now = new Date();
    const via: string | undefined = opts.via;

    if (changes.subject !== undefined && changes.subject && changes.subject !== ticket.subject) {
      data.subject = changes.subject.slice(0, 200);
      events.push({ type: "subject", fromValue: ticket.subject, toValue: data.subject as string });
    }
    if (changes.priority !== undefined && changes.priority !== ticket.priority) {
      if (!(TICKET_PRIORITIES as readonly string[]).includes(changes.priority)) throw new BadRequestException("Invalid priority");
      data.priority = changes.priority;
      events.push({ type: "priority", fromValue: ticket.priority, toValue: changes.priority });
    }
    if (changes.categoryId !== undefined && changes.categoryId !== ticket.categoryId) {
      const [from, to] = await Promise.all([this.categoryName(orgId, ticket.categoryId), this.categoryName(orgId, changes.categoryId, true)]);
      data.categoryId = changes.categoryId;
      events.push({ type: "category", fromValue: from, toValue: to });
    }
    if (changes.assigneeId !== undefined && changes.assigneeId !== ticket.assigneeId) {
      if (changes.assigneeId && !(await this.isStaff(orgId, changes.assigneeId))) {
        throw new BadRequestException("Assignee must be an owner or admin of this workspace");
      }
      const names = await this.userNames([ticket.assigneeId, changes.assigneeId]);
      data.assigneeId = changes.assigneeId;
      events.push({
        type: "assignee",
        fromValue: ticket.assigneeId ? (names.get(ticket.assigneeId) ?? null) : null,
        toValue: changes.assigneeId ? (names.get(changes.assigneeId) ?? null) : null,
      });
    }
    if (changes.companyId !== undefined && changes.companyId !== ticket.companyId) {
      const to = changes.companyId ? await this.assertCompany(orgId, changes.companyId) : null;
      const from = ticket.companyId
        ? await this.prisma.company.findFirst({ where: { id: ticket.companyId, organizationId: orgId }, select: { name: true } })
        : null;
      data.companyId = changes.companyId;
      events.push({ type: "company", fromValue: from?.name ?? null, toValue: to?.name ?? null });
    }
    if (changes.projectId !== undefined && changes.projectId !== ticket.projectId) {
      const to = changes.projectId ? await this.assertProject(orgId, changes.projectId) : null;
      data.projectId = changes.projectId;
      events.push({ type: "project", fromValue: null, toValue: to?.name ?? null });
    }

    let statusChange: { from: string; to: TicketStatus } | null = null;
    if (changes.status !== undefined && changes.status !== ticket.status) {
      if (ticket.mergedIntoId && !isDone(changes.status)) throw new BadRequestException("A merged ticket cannot be reopened");
      Object.assign(data, statusSideEffects(ticket, changes.status, now));
      Object.assign(data, await this.sla.onStatusChange(ticket, changes.status, now));
      statusChange = { from: ticket.status, to: changes.status };
      events.push({ type: "status", fromValue: ticket.status, toValue: changes.status });
    }

    // Priority, category or company can change which policy applies and the targets.
    const priorityChanged: boolean = data.priority !== undefined;
    const policyInputsChanged: boolean = data.categoryId !== undefined || data.companyId !== undefined;
    if (priorityChanged || policyInputsChanged) {
      const policyId: string | null = policyInputsChanged
        ? await this.sla.resolvePolicyId(
            orgId,
            data.categoryId !== undefined ? (data.categoryId as string | null) : ticket.categoryId,
            data.companyId !== undefined ? (data.companyId as string | null) : ticket.companyId,
          )
        : ticket.slaPolicyId;
      const pausedSeconds: number = (data.slaPausedSeconds as number | undefined) ?? ticket.slaPausedSeconds;
      Object.assign(
        data,
        await this.sla.recompute(
          { ...ticket, priority: (data.priority as string | undefined) ?? ticket.priority, slaPausedSeconds: pausedSeconds },
          policyId,
        ),
      );
    }

    if (events.length === 0) return ticket;
    data.lastActivityAt = now;
    const updated: Ticket = await this.prisma.$transaction(async (tx) => {
      const row = await tx.ticket.update({ where: { id: ticket.id }, data });
      await tx.ticketEvent.createMany({
        data: events.map((e) => ({ ticketId: ticket.id, actorId: actor.userId, ...e, detail: e.detail ?? via ?? null })),
      });
      return row;
    });

    if (statusChange) {
      this.notifications.statusChanged(ticket.id, statusChange.from, statusChange.to, { notifyRequester: opts.notifyRequester, note: opts.note });
    }
    if (data.assigneeId) this.notifications.assigned(ticket.id, data.assigneeId as string, actor.userId);
    if (data.categoryId !== undefined) {
      await this.audit.record({
        organizationId: orgId,
        actorId: actor.userId,
        action: "ticket.category_changed",
        targetType: "ticket",
        targetId: ticket.id,
        summary: `Category changed on #${ticket.number}`,
      });
    }
    if (opts.skipAutomation) return updated;
    return this.runAutomation("ticket_updated", updated);
  }

  async reply(id: string, orgId: string, actor: TicketActor, dto: StaffReplyDto) {
    const ticket = await this.getOrThrow(id, orgId);
    const visibility: "public" | "internal" = dto.visibility ?? "public";
    const body: string = normalizeMarkdown(dto.body);
    if (!body) throw new BadRequestException("Message is empty");
    const now = new Date();
    const message = await this.prisma.ticketMessage.create({
      data: {
        ticketId: id,
        organizationId: orgId,
        authorUserId: actor.userId,
        authorName: actor.name,
        authorEmail: actor.email ?? null,
        visibility,
        body,
        source: "staff",
      },
      select: MESSAGE_SELECT,
    });
    const touch: Prisma.TicketUncheckedUpdateInput = { lastActivityAt: now };
    if (visibility === "public" && !ticket.firstRespondedAt) {
      touch.firstRespondedAt = now;
      touch.slaWarnedAt = null;
    }
    const fresh: Ticket = await this.prisma.ticket.update({ where: { id }, data: touch });
    if (visibility === "public") {
      this.notifications.staffReplied(id, message.id, actor.name ?? "Support", body);
      const nextStatus: TicketStatus | undefined = dto.status ?? (fresh.status === "new" ? "open" : undefined);
      if (nextStatus && nextStatus !== fresh.status) {
        // The reply email already tells the requester; a separate status email would be noise.
        await this.changeTicket(fresh, { status: nextStatus }, actor, { notifyRequester: false });
      }
    } else if (dto.status && dto.status !== fresh.status) {
      await this.changeTicket(fresh, { status: dto.status }, actor, { notifyRequester: true });
    }
    return message;
  }

  async addStaffAttachment(id: string, orgId: string, userId: string, messageId: string, file: TempUploadedFile) {
    const ticket = await this.getOrThrow(id, orgId);
    const message = await this.prisma.ticketMessage.findFirst({ where: { id: messageId, ticketId: id }, select: { id: true } });
    if (!message) throw new BadRequestException("Unknown message");
    return this.storeAttachment(ticket, message.id, userId, file);
  }

  async downloadForStaff(attachmentId: string, orgId: string) {
    const attachment = await this.prisma.ticketAttachment.findFirst({ where: { id: attachmentId, organizationId: orgId } });
    if (!attachment) throw new NotFoundException("Attachment not found");
    return this.openAttachment(attachment);
  }

  async acceptTriage(id: string, orgId: string, actor: TicketActor, dto: AcceptTriageDto, req?: AuditRequestContext) {
    const ticket = await this.getOrThrow(id, orgId);
    if (!ticket.triage) throw new BadRequestException("Ticket is not in triage");
    const data: Prisma.TicketUncheckedUpdateInput = { triage: false };
    let summary = "Accepted from triage";
    if (dto.contactId) {
      const contact = await this.prisma.contact.findFirst({ where: { id: dto.contactId, organizationId: orgId } });
      if (!contact) throw new BadRequestException("Unknown contact");
      data.requesterContactId = contact.id;
      data.requesterName = contact.name;
      if (contact.email) data.requesterEmail = contact.email;
      data.requesterUserId = contact.userId && (await this.isMember(orgId, contact.userId)) ? contact.userId : null;
      data.companyId = contact.companyId ?? dto.companyId ?? null;
      summary = `Accepted from triage for ${contact.name}`;
    } else if (dto.companyId) {
      data.companyId = (await this.assertCompany(orgId, dto.companyId)).id;
    } else {
      throw new BadRequestException("Choose a contact or a company");
    }
    if (data.companyId) await this.assertCompany(orgId, data.companyId as string);
    await this.prisma.$transaction([
      this.prisma.ticket.update({ where: { id }, data }),
      this.prisma.ticketEvent.create({ data: { ticketId: id, actorId: actor.userId, type: "triage_accepted", detail: summary } }),
    ]);
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.userId,
      action: "ticket.triage_accepted",
      targetType: "ticket",
      targetId: id,
      summary,
      ...auditContext(req),
    });
    return this.findOne(id, orgId);
  }

  async remove(id: string, orgId: string, actorId: string, req?: AuditRequestContext): Promise<void> {
    const ticket = await this.getOrThrow(id, orgId);
    const files = await this.prisma.ticketAttachment.findMany({ where: { ticketId: id }, select: { storageKey: true } });
    await this.prisma.ticket.delete({ where: { id } });
    await Promise.all(files.map((f) => this.attachments.remove(f.storageKey)));
    await this.audit.record({
      organizationId: orgId,
      actorId,
      action: "ticket.deleted",
      targetType: "ticket",
      targetId: id,
      summary: `Deleted ticket #${ticket.number}: ${ticket.subject}`,
      ...auditContext(req),
    });
  }

  async addLabel(id: string, orgId: string, actorId: string | null, labelId: string) {
    await this.getOrThrow(id, orgId);
    const label = await this.prisma.label.findFirst({ where: { id: labelId, organizationId: orgId }, select: { id: true, name: true } });
    if (!label) throw new BadRequestException("Unknown label");
    const existing = await this.prisma.ticketLabel.findUnique({ where: { ticketId_labelId: { ticketId: id, labelId } } });
    if (!existing) {
      await this.prisma.$transaction([
        this.prisma.ticketLabel.create({ data: { ticketId: id, labelId } }),
        this.prisma.ticketEvent.create({ data: { ticketId: id, actorId, type: "label_added", toValue: label.name } }),
      ]);
    }
    return { ok: true };
  }

  async removeLabel(id: string, orgId: string, actorId: string, labelId: string) {
    await this.getOrThrow(id, orgId);
    const label = await this.prisma.label.findFirst({ where: { id: labelId, organizationId: orgId }, select: { name: true } });
    const { count } = await this.prisma.ticketLabel.deleteMany({ where: { ticketId: id, labelId } });
    if (count > 0) {
      await this.prisma.ticketEvent.create({ data: { ticketId: id, actorId, type: "label_removed", fromValue: label?.name ?? null } });
    }
    return { ok: true };
  }

  async link(id: string, orgId: string, actorId: string, relatedId: string, type: string) {
    if (id === relatedId) throw new BadRequestException("A ticket cannot be linked to itself");
    const [a, b] = await Promise.all([this.getOrThrow(id, orgId), this.getOrThrow(relatedId, orgId)]);
    const exists = await this.prisma.ticketLink.findFirst({
      where: { OR: [{ ticketId: a.id, relatedTicketId: b.id }, { ticketId: b.id, relatedTicketId: a.id }] },
    });
    if (exists) return exists;
    const [link] = await this.prisma.$transaction([
      this.prisma.ticketLink.create({ data: { ticketId: a.id, relatedTicketId: b.id, type } }),
      this.prisma.ticketEvent.create({ data: { ticketId: a.id, actorId, type: "linked", toValue: `#${b.number}` } }),
      this.prisma.ticketEvent.create({ data: { ticketId: b.id, actorId, type: "linked", toValue: `#${a.number}` } }),
    ]);
    return link;
  }

  async unlink(id: string, orgId: string, linkId: string) {
    await this.getOrThrow(id, orgId);
    await this.prisma.ticketLink.deleteMany({ where: { id: linkId, OR: [{ ticketId: id }, { relatedTicketId: id }] } });
    return { ok: true };
  }

  // ─── Automation ───

  /** Runs one round of rules; changes made by rules never trigger another round. */
  async runAutomation(trigger: "ticket_created" | "ticket_updated", ticket: Ticket): Promise<Ticket> {
    const result = await this.automation.evaluate(trigger, ticket);
    if (!result) return ticket;
    const { outcome, ruleNames } = result;
    const via = `automation: ${ruleNames.join(", ")}`.slice(0, 500);
    const changes: TicketChanges = {};
    if (outcome.priority) changes.priority = outcome.priority;
    if (outcome.status) changes.status = outcome.status as TicketStatus;
    if (outcome.categoryId && (await this.categoryExists(ticket.organizationId, outcome.categoryId))) changes.categoryId = outcome.categoryId;
    if (outcome.assigneeId && (await this.isStaff(ticket.organizationId, outcome.assigneeId))) changes.assigneeId = outcome.assigneeId;
    let updated: Ticket = ticket;
    try {
      updated = await this.changeTicket(ticket, changes, { userId: null, name: "Automation" }, { notifyRequester: true, via, skipAutomation: true });
    } catch {
      updated = ticket;
    }
    for (const labelId of outcome.labelIds) {
      const label = await this.prisma.label.findFirst({ where: { id: labelId, organizationId: ticket.organizationId }, select: { id: true } });
      if (label) await this.addLabel(ticket.id, ticket.organizationId, null, label.id).catch(() => undefined);
    }
    return updated;
  }

  // ─── helpers ───

  async getOrThrow(id: string, orgId: string): Promise<Ticket> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, organizationId: orgId } });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return ticket;
  }

  async isStaff(orgId: string, userId: string): Promise<boolean> {
    const count: number = await this.prisma.member.count({
      where: { organizationId: orgId, userId, role: { in: ["owner", "admin"] } },
    });
    return count > 0;
  }

  private async isMember(orgId: string, userId: string): Promise<boolean> {
    return (await this.prisma.member.count({ where: { organizationId: orgId, userId } })) > 0;
  }

  private async categoryExists(orgId: string, id: string): Promise<boolean> {
    return (await this.prisma.ticketCategory.count({ where: { id, organizationId: orgId, archivedAt: null } })) > 0;
  }

  private async categoryName(orgId: string, id: string | null, mustExist = false): Promise<string | null> {
    if (!id) return null;
    const category = await this.prisma.ticketCategory.findFirst({ where: { id, organizationId: orgId }, select: { name: true } });
    if (!category && mustExist) throw new BadRequestException("Unknown category");
    return category?.name ?? null;
  }

  async assertCompany(orgId: string, id: string): Promise<{ id: string; name: string }> {
    const company = await this.prisma.company.findFirst({ where: { id, organizationId: orgId }, select: { id: true, name: true } });
    if (!company) throw new BadRequestException("Unknown company");
    return company;
  }

  async assertProject(orgId: string, id: string): Promise<{ id: string; name: string }> {
    const project = await this.prisma.project.findFirst({ where: { id, organizationId: orgId }, select: { id: true, name: true } });
    if (!project) throw new BadRequestException("Unknown project");
    return project;
  }

  async userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const unique: string[] = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  async userActor(userId: string): Promise<TicketActor> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    return { userId, name: user?.name ?? null, email: user?.email ?? null };
  }

  private async storeAttachment(ticket: Ticket, messageId: string, userId: string | null, file: TempUploadedFile) {
    const stored = await this.attachments.store(file, ticket.organizationId, `tickets/${ticket.id}`);
    return this.prisma.ticketAttachment.create({
      data: {
        ticketId: ticket.id,
        messageId,
        organizationId: ticket.organizationId,
        storageKey: stored.storageKey,
        filename: stored.filename,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        scanStatus: stored.scanStatus,
        uploadedById: userId,
      },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, scanStatus: true, createdAt: true, messageId: true },
    });
  }

  private async openAttachment(attachment: { storageKey: string; filename: string; mimeType: string }) {
    const { body } = await this.attachments.download(attachment.storageKey);
    return { body, filename: attachment.filename, mimeType: attachment.mimeType };
  }
}
