import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { SettingsService } from "../settings/settings.service";
import { AuditService, ServiceSettingsService, auditContext, isValidSchedule } from "../service-core";
import type { AuditRequestContext } from "../service-core";
import { isValidTimeZone } from "../common/helpers/local-time";
import { publicApiUrl } from "../common/helpers/public-api-url";
import { HelpdeskDefaultsService } from "./helpdesk-defaults.service";
import { isValidTargets } from "./sla";
import { testImapConnection, type ImapConfig } from "./inbound/imap-client";
import type {
  BusinessHoursDto,
  CategoryDto,
  HelpdeskSettingsDto,
  HolidayDto,
  InboundSettingsDto,
  SlaPolicyDto,
  UpdateBusinessHoursDto,
  UpdateCategoryDto,
  UpdateSlaPolicyDto,
} from "./helpdesk.dto";

const MAX_CATEGORIES = 100;
const MAX_POLICIES = 50;

@Injectable()
export class HelpdeskSettingsService {
  constructor(
    private prisma: PrismaService,
    private serviceSettings: ServiceSettingsService,
    private settings: SettingsService,
    private defaults: HelpdeskDefaultsService,
    private audit: AuditService,
    private config: ConfigService,
  ) {}

  // ─── General ───

  async get(orgId: string) {
    await this.defaults.ensure(orgId);
    const s = await this.serviceSettings.get(orgId);
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    return {
      ticketPrefix: s.ticketPrefix,
      nextTicketNumber: s.nextTicketNumber,
      autoAcknowledge: s.autoAcknowledge,
      csatEnabled: s.csatEnabled,
      clientsCanClose: s.clientsCanClose,
      closeResolvedAfterDays: s.closeResolvedAfterDays,
      closeWaitingAfterDays: s.closeWaitingAfterDays,
      triageAssigneeId: s.triageAssigneeId,
      defaultSlaPolicyId: s.defaultSlaPolicyId,
      inbound: {
        mode: s.inboundMode,
        address: s.inboundAddress,
        webhookUrl: org?.slug ? `${publicApiUrl(this.config)}/api/helpdesk/inbound/${org.slug}` : null,
        hasWebhookSecret: !!s.inboundWebhookSecret,
        imapHost: s.imapHost,
        imapPort: s.imapPort,
        imapUser: s.imapUser,
        hasImapPassword: !!s.imapPass,
        imapSecure: s.imapSecure,
        imapMailbox: s.imapMailbox,
        imapLastPolledAt: s.imapLastPolledAt,
        imapLastError: s.imapLastError,
      },
    };
  }

  async update(orgId: string, actorId: string, dto: HelpdeskSettingsDto, req?: AuditRequestContext) {
    if (dto.triageAssigneeId) await this.assertStaff(orgId, dto.triageAssigneeId);
    if (dto.defaultSlaPolicyId) await this.assertPolicy(orgId, dto.defaultSlaPolicyId);
    await this.serviceSettings.update(orgId, {
      ticketPrefix: dto.ticketPrefix,
      autoAcknowledge: dto.autoAcknowledge,
      csatEnabled: dto.csatEnabled,
      clientsCanClose: dto.clientsCanClose,
      closeResolvedAfterDays: dto.closeResolvedAfterDays,
      closeWaitingAfterDays: dto.closeWaitingAfterDays,
      triageAssigneeId: dto.triageAssigneeId,
      defaultSlaPolicyId: dto.defaultSlaPolicyId,
    });
    await this.audit.record({
      organizationId: orgId,
      actorId,
      action: "helpdesk.settings_updated",
      targetType: "service_settings",
      summary: "Helpdesk settings updated",
      metadata: { ...dto } as Prisma.InputJsonValue,
      ...auditContext(req),
    });
    return this.get(orgId);
  }

  // ─── Inbound email ───

  async updateInbound(orgId: string, actorId: string, dto: InboundSettingsDto, req?: AuditRequestContext) {
    const data: Prisma.ServiceSettingsUpdateInput = {
      inboundMode: dto.inboundMode,
      inboundAddress: dto.inboundAddress === "" ? null : dto.inboundAddress?.toLowerCase(),
      imapHost: dto.imapHost === "" ? null : dto.imapHost,
      imapPort: dto.imapPort,
      imapUser: dto.imapUser === "" ? null : dto.imapUser,
      imapSecure: dto.imapSecure,
      imapMailbox: dto.imapMailbox,
    };
    if (dto.imapPass !== undefined) {
      data.imapPass = dto.imapPass ? this.settings.encrypt(dto.imapPass) : null;
    } else if (dto.imapHost !== undefined || dto.imapUser !== undefined) {
      // The stored password is only ever sent to the server it was entered for.
      const current = await this.serviceSettings.get(orgId);
      if ((dto.imapHost !== undefined && (dto.imapHost || null) !== current.imapHost) || (dto.imapUser !== undefined && (dto.imapUser || null) !== current.imapUser)) {
        data.imapPass = null;
      }
    }
    if (dto.imapHost !== undefined || dto.imapUser !== undefined || dto.imapMailbox !== undefined) {
      // A different mailbox starts from its newest message rather than replaying history.
      data.imapLastUid = null;
      data.imapLastError = null;
    }
    await this.serviceSettings.update(orgId, data);
    await this.audit.record({
      organizationId: orgId,
      actorId,
      action: "helpdesk.inbound_updated",
      targetType: "service_settings",
      summary: `Inbound email set to ${dto.inboundMode ?? "unchanged mode"}`,
      metadata: { mode: dto.inboundMode ?? null, address: dto.inboundAddress ?? null, imapHost: dto.imapHost ?? null },
      ...auditContext(req),
    });
    return this.get(orgId);
  }

  /** New webhook signing secret; returned once, stored encrypted. */
  async rotateWebhookSecret(orgId: string, actorId: string, req?: AuditRequestContext): Promise<{ secret: string }> {
    const secret: string = `whsec_${randomBytes(32).toString("hex")}`;
    await this.serviceSettings.update(orgId, { inboundWebhookSecret: this.settings.encrypt(secret) });
    await this.audit.record({
      organizationId: orgId,
      actorId,
      action: "helpdesk.inbound_secret_rotated",
      targetType: "service_settings",
      summary: "Inbound webhook secret rotated",
      ...auditContext(req),
    });
    return { secret };
  }

  async testImap(orgId: string): Promise<{ ok: boolean; error?: string; messages?: number }> {
    const s = await this.serviceSettings.get(orgId);
    if (!s.imapHost || !s.imapUser || !s.imapPass) return { ok: false, error: "IMAP host, user and password are required" };
    const cfg: ImapConfig = {
      host: s.imapHost,
      port: s.imapPort ?? (s.imapSecure ? 993 : 143),
      secure: s.imapSecure,
      user: s.imapUser,
      pass: this.settings.decrypt(s.imapPass),
      mailbox: s.imapMailbox,
    };
    return testImapConnection(cfg);
  }

  // ─── Categories ───

  async listCategories(orgId: string, includeArchived = true) {
    await this.defaults.ensure(orgId);
    return this.prisma.ticketCategory.findMany({
      where: { organizationId: orgId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      include: { _count: { select: { tickets: true } } },
    });
  }

  async portalCategories(orgId: string) {
    await this.defaults.ensure(orgId);
    return this.prisma.ticketCategory.findMany({
      where: { organizationId: orgId, archivedAt: null, portalVisible: true },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, name: true, description: true, color: true, defaultPriority: true },
    });
  }

  async createCategory(orgId: string, actorId: string, dto: CategoryDto) {
    if ((await this.prisma.ticketCategory.count({ where: { organizationId: orgId } })) >= MAX_CATEGORIES) {
      throw new BadRequestException(`A workspace can have at most ${MAX_CATEGORIES} categories`);
    }
    await this.assertCategoryRefs(orgId, dto);
    try {
      const category = await this.prisma.ticketCategory.create({
        data: {
          organizationId: orgId,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          color: dto.color,
          order: dto.order,
          defaultPriority: dto.defaultPriority,
          defaultAssigneeId: dto.defaultAssigneeId ?? null,
          slaPolicyId: dto.slaPolicyId ?? null,
          portalVisible: dto.portalVisible,
        },
      });
      await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.category_created", targetType: "ticket_category", targetId: category.id, summary: category.name });
      return category;
    } catch (err) {
      throw this.duplicate(err, "A category with this name already exists");
    }
  }

  async updateCategory(orgId: string, id: string, actorId: string, dto: UpdateCategoryDto) {
    const existing = await this.prisma.ticketCategory.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException("Category not found");
    await this.assertCategoryRefs(orgId, dto);
    try {
      const category = await this.prisma.ticketCategory.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          description: dto.description === undefined ? undefined : dto.description.trim() || null,
          color: dto.color,
          order: dto.order,
          defaultPriority: dto.defaultPriority,
          defaultAssigneeId: dto.defaultAssigneeId,
          slaPolicyId: dto.slaPolicyId,
          portalVisible: dto.portalVisible,
          archivedAt: dto.archived === undefined ? undefined : dto.archived ? (existing.archivedAt ?? new Date()) : null,
        },
      });
      await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.category_updated", targetType: "ticket_category", targetId: id, summary: category.name, metadata: { ...dto } as Prisma.InputJsonValue });
      return category;
    } catch (err) {
      throw this.duplicate(err, "A category with this name already exists");
    }
  }

  /** Categories with tickets are archived instead, so history keeps its labels. */
  async removeCategory(orgId: string, id: string, actorId: string) {
    const existing = await this.prisma.ticketCategory.findFirst({ where: { id, organizationId: orgId }, include: { _count: { select: { tickets: true } } } });
    if (!existing) throw new NotFoundException("Category not found");
    if (existing._count.tickets > 0) {
      await this.prisma.ticketCategory.update({ where: { id }, data: { archivedAt: existing.archivedAt ?? new Date() } });
    } else {
      await this.prisma.ticketCategory.delete({ where: { id } });
    }
    await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.category_deleted", targetType: "ticket_category", targetId: id, summary: existing.name });
    return { archived: existing._count.tickets > 0 };
  }

  // ─── SLA policies ───

  async listPolicies(orgId: string) {
    await this.defaults.ensure(orgId);
    return this.prisma.slaPolicy.findMany({
      where: { organizationId: orgId },
      orderBy: { name: "asc" },
      include: { businessHours: { select: { id: true, name: true } } },
    });
  }

  async createPolicy(orgId: string, actorId: string, dto: SlaPolicyDto) {
    if (!isValidTargets(dto.targets)) throw new BadRequestException("Every priority needs positive first response and resolution targets");
    if ((await this.prisma.slaPolicy.count({ where: { organizationId: orgId } })) >= MAX_POLICIES) {
      throw new BadRequestException(`A workspace can have at most ${MAX_POLICIES} SLA policies`);
    }
    if (dto.businessHoursId) await this.assertCalendar(orgId, dto.businessHoursId);
    if (dto.escalateToId) await this.assertStaff(orgId, dto.escalateToId);
    try {
      const policy = await this.prisma.slaPolicy.create({
        data: {
          organizationId: orgId,
          name: dto.name.trim(),
          targets: pickTargets(dto.targets),
          businessHoursId: dto.businessHoursId ?? null,
          warnAtPercent: dto.warnAtPercent,
          escalateToId: dto.escalateToId ?? null,
        },
      });
      await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.sla_created", targetType: "sla_policy", targetId: policy.id, summary: policy.name });
      return policy;
    } catch (err) {
      throw this.duplicate(err, "A policy with this name already exists");
    }
  }

  /** Changes apply to new tickets and to due dates recomputed later (priority change, resume). */
  async updatePolicy(orgId: string, id: string, actorId: string, dto: UpdateSlaPolicyDto) {
    await this.assertPolicy(orgId, id);
    if (dto.targets !== undefined && !isValidTargets(dto.targets)) {
      throw new BadRequestException("Every priority needs positive first response and resolution targets");
    }
    if (dto.businessHoursId) await this.assertCalendar(orgId, dto.businessHoursId);
    if (dto.escalateToId) await this.assertStaff(orgId, dto.escalateToId);
    try {
      const policy = await this.prisma.slaPolicy.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          targets: dto.targets ? pickTargets(dto.targets) : undefined,
          businessHoursId: dto.businessHoursId,
          warnAtPercent: dto.warnAtPercent,
          escalateToId: dto.escalateToId,
        },
      });
      await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.sla_updated", targetType: "sla_policy", targetId: id, summary: policy.name, metadata: { ...dto } as Prisma.InputJsonValue });
      return policy;
    } catch (err) {
      throw this.duplicate(err, "A policy with this name already exists");
    }
  }

  async removePolicy(orgId: string, id: string, actorId: string) {
    await this.assertPolicy(orgId, id);
    await this.prisma.$transaction([
      this.prisma.serviceSettings.updateMany({ where: { organizationId: orgId, defaultSlaPolicyId: id }, data: { defaultSlaPolicyId: null } }),
      this.prisma.slaPolicy.delete({ where: { id } }),
    ]);
    await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.sla_deleted", targetType: "sla_policy", targetId: id });
    return { ok: true };
  }

  // ─── Business hours ───

  async listCalendars(orgId: string) {
    await this.defaults.ensure(orgId);
    return this.prisma.businessHours.findMany({
      where: { organizationId: orgId },
      orderBy: { name: "asc" },
      include: { holidays: { orderBy: { date: "asc" } } },
    });
  }

  async createCalendar(orgId: string, actorId: string, dto: BusinessHoursDto) {
    this.assertSchedule(dto.timezone, dto.schedule);
    try {
      const cal = await this.prisma.businessHours.create({
        data: { organizationId: orgId, name: dto.name.trim(), timezone: dto.timezone, schedule: dto.schedule.map((w) => ({ day: w.day, start: w.start, end: w.end })) },
      });
      await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.business_hours_created", targetType: "business_hours", targetId: cal.id, summary: cal.name });
      return cal;
    } catch (err) {
      throw this.duplicate(err, "A calendar with this name already exists");
    }
  }

  async updateCalendar(orgId: string, id: string, actorId: string, dto: UpdateBusinessHoursDto) {
    const existing = await this.assertCalendar(orgId, id);
    this.assertSchedule(dto.timezone ?? existing.timezone, dto.schedule ?? (existing.schedule as unknown[]));
    try {
      const cal = await this.prisma.businessHours.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          timezone: dto.timezone,
          schedule: dto.schedule ? dto.schedule.map((w) => ({ day: w.day, start: w.start, end: w.end })) : undefined,
        },
      });
      await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.business_hours_updated", targetType: "business_hours", targetId: id, summary: cal.name });
      return cal;
    } catch (err) {
      throw this.duplicate(err, "A calendar with this name already exists");
    }
  }

  async removeCalendar(orgId: string, id: string, actorId: string) {
    await this.assertCalendar(orgId, id);
    await this.prisma.businessHours.delete({ where: { id } });
    await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.business_hours_deleted", targetType: "business_hours", targetId: id });
    return { ok: true };
  }

  async addHoliday(orgId: string, calendarId: string, actorId: string, dto: HolidayDto) {
    await this.assertCalendar(orgId, calendarId);
    const date = new Date(`${dto.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) throw new BadRequestException("Invalid date");
    try {
      const holiday = await this.prisma.businessHoliday.create({ data: { businessHoursId: calendarId, date, name: dto.name.trim() } });
      await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.holiday_added", targetType: "business_hours", targetId: calendarId, summary: `${dto.date} ${dto.name}` });
      return holiday;
    } catch (err) {
      throw this.duplicate(err, "That date is already a holiday");
    }
  }

  async removeHoliday(orgId: string, calendarId: string, holidayId: string, actorId: string) {
    await this.assertCalendar(orgId, calendarId);
    await this.prisma.businessHoliday.deleteMany({ where: { id: holidayId, businessHoursId: calendarId } });
    await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.holiday_removed", targetType: "business_hours", targetId: calendarId });
    return { ok: true };
  }

  // ─── Company admins ───

  /** A company admin sees every ticket of their company in the portal. Needs a contact with a company. */
  async setCompanyAdmin(orgId: string, contactId: string, actorId: string, companyAdmin: boolean, req?: AuditRequestContext) {
    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, organizationId: orgId }, select: { id: true, name: true, companyId: true } });
    if (!contact) throw new NotFoundException("Contact not found");
    if (companyAdmin && !contact.companyId) throw new BadRequestException("The contact needs a company first");
    await this.prisma.contact.update({ where: { id: contact.id }, data: { companyAdmin } });
    await this.audit.record({
      organizationId: orgId,
      actorId,
      action: companyAdmin ? "contact.company_admin_granted" : "contact.company_admin_revoked",
      targetType: "contact",
      targetId: contact.id,
      summary: `${contact.name} ${companyAdmin ? "is now" : "is no longer"} a company admin`,
      ...auditContext(req),
    });
    return { id: contact.id, companyAdmin };
  }

  // ─── Staff list (assignee pickers) ───

  async staff(orgId: string) {
    const members = await this.prisma.member.findMany({
      where: { organizationId: orgId, role: { in: ["owner", "admin"] } },
      select: { userId: true, role: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
    return members.map((m) => ({ userId: m.userId, role: m.role, name: m.user.name, email: m.user.email }));
  }

  // ─── helpers ───

  private assertSchedule(timezone: string, schedule: unknown) {
    if (!isValidTimeZone(timezone)) throw new BadRequestException("Unknown time zone");
    if (!isValidSchedule(schedule)) throw new BadRequestException("Invalid schedule: each window needs a day 0-6 and start before end");
  }

  private async assertCategoryRefs(orgId: string, dto: Partial<CategoryDto>) {
    if (dto.defaultAssigneeId) await this.assertStaff(orgId, dto.defaultAssigneeId);
    if (dto.slaPolicyId) await this.assertPolicy(orgId, dto.slaPolicyId);
  }

  private async assertStaff(orgId: string, userId: string) {
    const ok = await this.prisma.member.count({ where: { organizationId: orgId, userId, role: { in: ["owner", "admin"] } } });
    if (!ok) throw new BadRequestException("Must be an owner or admin of this workspace");
  }

  private async assertPolicy(orgId: string, id: string) {
    const policy = await this.prisma.slaPolicy.findFirst({ where: { id, organizationId: orgId }, select: { id: true } });
    if (!policy) throw new NotFoundException("SLA policy not found");
  }

  private async assertCalendar(orgId: string, id: string) {
    const cal = await this.prisma.businessHours.findFirst({ where: { id, organizationId: orgId } });
    if (!cal) throw new NotFoundException("Business hours not found");
    return cal;
  }

  private duplicate(err: unknown, message: string): unknown {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      return new BadRequestException(message);
    }
    return err;
  }
}

function pickTargets(targets: Record<string, { firstResponseMins: number; resolutionMins: number }>): Prisma.InputJsonValue {
  const out: Record<string, { firstResponseMins: number; resolutionMins: number }> = {};
  for (const p of ["low", "normal", "high", "urgent"]) {
    out[p] = { firstResponseMins: targets[p].firstResponseMins, resolutionMins: targets[p].resolutionMins };
  }
  return out;
}
