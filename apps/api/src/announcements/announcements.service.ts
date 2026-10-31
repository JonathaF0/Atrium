import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { paginatedResponse, paginationArgs } from "../common";
import {
  AuditService,
  ServiceSettingsService,
  formatReference,
  normalizeMarkdown,
  type AuditRequestContext,
  auditContext,
} from "../service-core";
import { AudienceResolver } from "./audience-resolver.service";
import { AnnouncementNotificationsService } from "./announcement-notifications.service";
import { canTransition, type AnnouncementAction } from "./announcement-state";
import type {
  AnnouncementListQueryDto,
  AnnouncementUpdatePostDto,
  AudienceDto,
  CreateAnnouncementDto,
  CreateTemplateDto,
  UpdateAnnouncementDto,
  UpdateTemplateDto,
} from "./announcements.dto";

export interface Actor {
  id: string;
  email?: string | null;
  req?: AuditRequestContext;
}

const DETAIL_INCLUDE = {
  updates: { orderBy: { createdAt: "asc" } },
  audiences: { select: { companyId: true, company: { select: { id: true, name: true } } } },
  _count: { select: { tickets: true } },
} satisfies Prisma.AnnouncementInclude;

type AnnouncementDetail = Prisma.AnnouncementGetPayload<{ include: typeof DETAIL_INCLUDE }>;

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Normalised audience after validation. */
interface ResolvedAudience {
  audienceType: string;
  audienceValue: string | null;
  companyIds: string[];
}

@Injectable()
export class AnnouncementsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private settings: ServiceSettingsService,
    private audience: AudienceResolver,
    private notifier: AnnouncementNotificationsService,
  ) {}

  // ─── Read ───

  async list(organizationId: string, query: AnnouncementListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.AnnouncementWhereInput = { organizationId };
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    const [data, total] = await Promise.all([
      this.prisma.announcement.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }],
        include: { _count: { select: { updates: true, tickets: true, audiences: true } } },
        ...paginationArgs(page, limit),
      }),
      this.prisma.announcement.count({ where }),
    ]);
    return paginatedResponse(data, total, page, limit);
  }

  async get(organizationId: string, id: string): Promise<AnnouncementDetail> {
    const found = await this.prisma.announcement.findFirst({
      where: { id, organizationId },
      include: DETAIL_INCLUDE,
    });
    if (!found) throw new NotFoundException("Announcement not found");
    return found;
  }

  // ─── Write ───

  /** Validates the audience against this workspace; never trusts company ids from the client. */
  private async resolveAudience(organizationId: string, input: AudienceDto, current?: ResolvedAudience): Promise<ResolvedAudience> {
    const audienceType = input.audienceType ?? current?.audienceType ?? "all";
    if (audienceType === "all") return { audienceType, audienceValue: null, companyIds: [] };
    if (audienceType === "companies") {
      const ids = [...new Set(input.companyIds ?? current?.companyIds ?? [])];
      if (ids.length === 0) throw new BadRequestException("Choose at least one company");
      const found = await this.prisma.company.count({ where: { organizationId, id: { in: ids } } });
      if (found !== ids.length) throw new BadRequestException("Unknown company in audience");
      return { audienceType, audienceValue: null, companyIds: ids };
    }
    const value = (input.audienceValue !== undefined ? input.audienceValue : current?.audienceValue)?.trim();
    if (!value) throw new BadRequestException("Audience value is required for this audience type");
    return { audienceType, audienceValue: value, companyIds: [] };
  }

  private validateShape(merged: {
    type: string;
    publicStatus: boolean;
    audienceType: string;
    windowStart: Date | null;
    windowEnd: Date | null;
  }): void {
    if (merged.publicStatus && merged.audienceType !== "all") {
      throw new BadRequestException("Only announcements for all clients can appear on the public status page");
    }
    if (merged.windowStart && merged.windowEnd && merged.windowEnd.getTime() < merged.windowStart.getTime()) {
      throw new BadRequestException("Maintenance window ends before it starts");
    }
  }

  async create(organizationId: string, actor: Actor, dto: CreateAnnouncementDto): Promise<AnnouncementDetail> {
    let template: { type: string; severity: string; title: string; body: string } | null = null;
    if (dto.templateId) {
      template = await this.prisma.announcementTemplate.findFirst({
        where: { id: dto.templateId, organizationId },
        select: { type: true, severity: true, title: true, body: true },
      });
      if (!template) throw new NotFoundException("Template not found");
    }
    const type = dto.type ?? template?.type;
    const title = (dto.title ?? template?.title)?.trim();
    if (!type) throw new BadRequestException("Type is required");
    if (!title) throw new BadRequestException("Title is required");

    const audience = await this.resolveAudience(organizationId, dto);
    const windowStart = toDate(dto.windowStart) ?? null;
    const windowEnd = toDate(dto.windowEnd) ?? null;
    const publicStatus = dto.publicStatus ?? false;
    this.validateShape({ type, publicStatus, audienceType: audience.audienceType, windowStart, windowEnd });

    const incidentState = type === "incident" ? (dto.incidentState ?? "investigating") : null;
    const created = await this.prisma.announcement.create({
      data: {
        organizationId,
        type,
        severity: dto.severity ?? template?.severity ?? "info",
        incidentState,
        resolvedAt: incidentState === "resolved" ? new Date() : null,
        title,
        body: normalizeMarkdown(dto.body ?? template?.body ?? ""),
        impact: dto.impact?.trim() || null,
        windowStart,
        windowEnd,
        expiresAt: toDate(dto.expiresAt) ?? null,
        postmortem: dto.postmortem ? normalizeMarkdown(dto.postmortem) : null,
        audienceType: audience.audienceType,
        audienceValue: audience.audienceValue,
        categoryIds: dto.categoryIds ?? [],
        publicStatus,
        emailOnPublish: dto.emailOnPublish ?? false,
        pushOnPublish: dto.pushOnPublish ?? false,
        createdById: actor.id,
        audiences: { create: audience.companyIds.map((companyId) => ({ companyId })) },
      },
    });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.created",
      targetType: "announcement",
      targetId: created.id,
      summary: `Created ${type} announcement "${title}"`,
      metadata: { templateId: dto.templateId ?? null },
      ...auditContext(actor.req),
    });
    return this.get(organizationId, created.id);
  }

  async update(organizationId: string, id: string, actor: Actor, dto: UpdateAnnouncementDto): Promise<AnnouncementDetail> {
    const current = await this.get(organizationId, id);
    const audienceTouched =
      dto.audienceType !== undefined || dto.audienceValue !== undefined || dto.companyIds !== undefined;
    const audience = audienceTouched
      ? await this.resolveAudience(organizationId, dto, {
          audienceType: current.audienceType,
          audienceValue: current.audienceValue,
          companyIds: current.audiences.map((a) => a.companyId),
        })
      : null;

    const type = dto.type ?? current.type;
    const windowStart = dto.windowStart !== undefined ? toDate(dto.windowStart) ?? null : current.windowStart;
    const windowEnd = dto.windowEnd !== undefined ? toDate(dto.windowEnd) ?? null : current.windowEnd;
    const publicStatus = dto.publicStatus ?? current.publicStatus;
    this.validateShape({
      type,
      publicStatus,
      audienceType: audience?.audienceType ?? current.audienceType,
      windowStart,
      windowEnd,
    });

    const incidentState: string | null =
      type === "incident" ? (dto.incidentState ?? current.incidentState ?? "investigating") : null;
    const resolvedAt = incidentState === "resolved" ? (current.resolvedAt ?? new Date()) : null;

    const data: Prisma.AnnouncementUpdateInput = {
      type,
      severity: dto.severity,
      incidentState,
      resolvedAt,
      title: dto.title?.trim(),
      body: dto.body !== undefined ? normalizeMarkdown(dto.body) : undefined,
      impact: dto.impact !== undefined ? dto.impact?.trim() || null : undefined,
      windowStart,
      windowEnd,
      expiresAt: toDate(dto.expiresAt),
      postmortem: dto.postmortem !== undefined ? (dto.postmortem ? normalizeMarkdown(dto.postmortem) : null) : undefined,
      categoryIds: dto.categoryIds,
      publicStatus,
      emailOnPublish: dto.emailOnPublish,
      pushOnPublish: dto.pushOnPublish,
    };
    // A changed window deserves a fresh reminder.
    if ((current.windowStart?.getTime() ?? null) !== (windowStart?.getTime() ?? null)) data.reminderSentAt = null;
    if (audience) {
      data.audienceType = audience.audienceType;
      data.audienceValue = audience.audienceValue;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.announcement.update({ where: { id }, data });
      if (audience) {
        await tx.announcementAudience.deleteMany({ where: { announcementId: id } });
        if (audience.companyIds.length > 0) {
          await tx.announcementAudience.createMany({
            data: audience.companyIds.map((companyId) => ({ announcementId: id, companyId })),
          });
        }
      }
    });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.edited",
      targetType: "announcement",
      targetId: id,
      summary: `Edited announcement "${dto.title?.trim() ?? current.title}"`,
      metadata: { fields: Object.keys(dto) },
      ...auditContext(actor.req),
    });
    return this.get(organizationId, id);
  }

  async remove(organizationId: string, id: string, actor: Actor): Promise<void> {
    const current = await this.get(organizationId, id);
    await this.prisma.announcement.delete({ where: { id } });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.deleted",
      targetType: "announcement",
      targetId: id,
      summary: `Deleted announcement "${current.title}"`,
      metadata: { status: current.status, type: current.type },
      ...auditContext(actor.req),
    });
  }

  // ─── Lifecycle ───

  /** Moves status only if it is still one the action allows, so concurrent clicks and the cron don't double-fire. */
  private async transition(
    organizationId: string,
    id: string,
    action: AnnouncementAction,
    data: Prisma.AnnouncementUpdateManyMutationInput,
  ): Promise<AnnouncementDetail> {
    const current = await this.get(organizationId, id);
    if (!canTransition(current.status, action)) {
      throw new BadRequestException(`Cannot ${action} an announcement that is ${current.status}`);
    }
    const { count } = await this.prisma.announcement.updateMany({
      where: { id, organizationId, status: current.status },
      data,
    });
    if (count === 0) throw new ConflictException("The announcement changed; reload and try again");
    return this.get(organizationId, id);
  }

  async publish(organizationId: string, id: string, actor: Actor): Promise<AnnouncementDetail> {
    const current = await this.get(organizationId, id);
    if (current.expiresAt && current.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("The expiry date is in the past");
    }
    if (current.publicStatus && current.audienceType !== "all") {
      throw new BadRequestException("Only announcements for all clients can appear on the public status page");
    }
    const published = await this.transition(organizationId, id, "publish", {
      status: "published",
      publishedAt: new Date(),
    });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.published",
      targetType: "announcement",
      targetId: id,
      summary: `Published announcement "${published.title}"`,
      metadata: { audienceType: published.audienceType, audienceValue: published.audienceValue },
      ...auditContext(actor.req),
    });
    await this.notifier.published(published, actor.id);
    return published;
  }

  async schedule(organizationId: string, id: string, actor: Actor, publishAt: Date): Promise<AnnouncementDetail> {
    if (Number.isNaN(publishAt.getTime()) || publishAt.getTime() <= Date.now()) {
      throw new BadRequestException("Schedule a time in the future");
    }
    const scheduled = await this.transition(organizationId, id, "schedule", { status: "scheduled", publishAt });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.scheduled",
      targetType: "announcement",
      targetId: id,
      summary: `Scheduled announcement "${scheduled.title}" for ${publishAt.toISOString()}`,
      ...auditContext(actor.req),
    });
    return scheduled;
  }

  async unpublish(organizationId: string, id: string, actor: Actor): Promise<AnnouncementDetail> {
    const draft = await this.transition(organizationId, id, "unpublish", {
      status: "draft",
      publishAt: null,
      publishedAt: null,
      reminderSentAt: null,
    });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.unpublished",
      targetType: "announcement",
      targetId: id,
      summary: `Unpublished announcement "${draft.title}"`,
      ...auditContext(actor.req),
    });
    return draft;
  }

  async expire(organizationId: string, id: string, actor: Actor): Promise<AnnouncementDetail> {
    const expired = await this.transition(organizationId, id, "expire", { status: "expired", expiresAt: new Date() });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.expired",
      targetType: "announcement",
      targetId: id,
      summary: `Expired announcement "${expired.title}"`,
      ...auditContext(actor.req),
    });
    return expired;
  }

  /** Adds a timeline entry; a state change moves the incident, and "resolved" closes it. */
  async postUpdate(organizationId: string, id: string, actor: Actor, dto: AnnouncementUpdatePostDto): Promise<AnnouncementDetail> {
    const current = await this.get(organizationId, id);
    if (dto.state && current.type !== "incident") {
      throw new BadRequestException("Only incidents have a state");
    }
    const state = dto.state ?? (current.type === "incident" ? current.incidentState : null);
    const body = normalizeMarkdown(dto.body);
    const data: Prisma.AnnouncementUpdateInput = {};
    if (current.type === "incident" && dto.state) {
      data.incidentState = dto.state;
      if (dto.state === "resolved") data.resolvedAt = current.resolvedAt ?? new Date();
      else data.resolvedAt = null;
    }
    if (dto.postmortem !== undefined) {
      if (state !== "resolved") throw new BadRequestException("A postmortem can be added once the incident is resolved");
      data.postmortem = dto.postmortem ? normalizeMarkdown(dto.postmortem) : null;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.announcementUpdate.create({ data: { announcementId: id, state, body, authorId: actor.id } });
      await tx.announcement.update({ where: { id }, data });
    });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.update_posted",
      targetType: "announcement",
      targetId: id,
      summary: `Posted update on "${current.title}"${state ? ` (${state})` : ""}`,
      metadata: { state, previousState: current.incidentState },
      ...auditContext(actor.req),
    });
    const updated = await this.get(organizationId, id);
    if (updated.status === "published") {
      await this.notifier.updated(updated, { body, state }, actor.id, dto.notify ?? true);
    }
    return updated;
  }

  async preview(organizationId: string, dto: AudienceDto) {
    const audience = await this.resolveAudience(organizationId, dto);
    return this.audience.preview(organizationId, {
      audienceType: audience.audienceType,
      audienceValue: audience.audienceValue,
      audiences: audience.companyIds.map((companyId) => ({ companyId })),
    });
  }

  // ─── Templates ───

  listTemplates(organizationId: string) {
    return this.prisma.announcementTemplate.findMany({ where: { organizationId }, orderBy: { name: "asc" } });
  }

  async createTemplate(organizationId: string, dto: CreateTemplateDto) {
    try {
      return await this.prisma.announcementTemplate.create({
        data: {
          organizationId,
          name: dto.name.trim(),
          type: dto.type,
          severity: dto.severity ?? "info",
          title: dto.title.trim(),
          body: normalizeMarkdown(dto.body),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A template with that name already exists");
      throw err;
    }
  }

  async updateTemplate(organizationId: string, id: string, dto: UpdateTemplateDto) {
    const found = await this.prisma.announcementTemplate.findFirst({ where: { id, organizationId } });
    if (!found) throw new NotFoundException("Template not found");
    try {
      return await this.prisma.announcementTemplate.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          type: dto.type,
          severity: dto.severity,
          title: dto.title?.trim(),
          body: dto.body !== undefined ? normalizeMarkdown(dto.body) : undefined,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A template with that name already exists");
      throw err;
    }
  }

  async removeTemplate(organizationId: string, id: string): Promise<void> {
    const { count } = await this.prisma.announcementTemplate.deleteMany({ where: { id, organizationId } });
    if (count === 0) throw new NotFoundException("Template not found");
  }

  // ─── Ticket links ───

  async listTickets(organizationId: string, id: string) {
    await this.get(organizationId, id);
    const [links, settings] = await Promise.all([
      this.prisma.ticketAnnouncement.findMany({
        where: { announcementId: id, ticket: { organizationId } },
        select: {
          ticket: { select: { id: true, number: true, subject: true, status: true, companyId: true } },
        },
      }),
      this.settings.get(organizationId),
    ]);
    return links.map((l) => ({ ...l.ticket, reference: formatReference(settings.ticketPrefix, l.ticket.number) }));
  }

  async linkTicket(organizationId: string, id: string, ticketId: string, actor: Actor): Promise<void> {
    const announcement = await this.get(organizationId, id);
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, organizationId }, select: { id: true, number: true } });
    if (!ticket) throw new NotFoundException("Ticket not found");
    try {
      await this.prisma.ticketAnnouncement.create({ data: { announcementId: id, ticketId } });
    } catch (err) {
      if (isUniqueViolation(err)) return;
      throw err;
    }
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.ticket_linked",
      targetType: "announcement",
      targetId: id,
      summary: `Linked ticket #${ticket.number} to "${announcement.title}"`,
      metadata: { ticketId },
      ...auditContext(actor.req),
    });
  }

  async unlinkTicket(organizationId: string, id: string, ticketId: string, actor: Actor): Promise<void> {
    await this.get(organizationId, id);
    const { count } = await this.prisma.ticketAnnouncement.deleteMany({
      where: { announcementId: id, ticketId, ticket: { organizationId } },
    });
    if (count === 0) throw new NotFoundException("Link not found");
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "announcement.ticket_unlinked",
      targetType: "announcement",
      targetId: id,
      metadata: { ticketId },
      ...auditContext(actor.req),
    });
  }

  // ─── Status page settings ───

  async statusSettings(organizationId: string): Promise<{ statusPageEnabled: boolean; slug: string | null }> {
    const [settings, org] = await Promise.all([
      this.settings.get(organizationId),
      this.prisma.organization.findUnique({ where: { id: organizationId }, select: { slug: true } }),
    ]);
    return { statusPageEnabled: settings.statusPageEnabled, slug: org?.slug ?? null };
  }

  async updateStatusSettings(organizationId: string, enabled: boolean, actor: Actor) {
    await this.settings.update(organizationId, { statusPageEnabled: enabled });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: enabled ? "status_page.enabled" : "status_page.disabled",
      targetType: "service_settings",
      summary: `Public status page ${enabled ? "enabled" : "disabled"}`,
      ...auditContext(actor.req),
    });
    return this.statusSettings(organizationId);
  }
}
