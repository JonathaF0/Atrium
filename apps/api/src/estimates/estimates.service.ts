import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { paginatedResponse, paginationArgs } from "../common";
import { AuditService, ServiceSettingsService, auditContext, formatReference } from "../service-core";
import type { AuditRequestContext } from "../service-core";
import { TaxRatesService } from "../catalog/tax-rates.service";
import { EstimateNotificationsService } from "./estimate-notifications.service";
import { EDITABLE_STATUSES, REVISABLE_STATUSES, SENDABLE_STATUSES, estimateTotals, inList } from "./estimate-math";
import { serializeForStaff, sortLines } from "./estimate-serialize";
import type {
  EstimateBodyDto,
  EstimateCommentDto,
  EstimateLineDto,
  EstimateListQueryDto,
  EstimateSettingsDto,
} from "./estimates.dto";

const DAY_MS = 86_400_000;

export const estimateDetailInclude = {
  lineItems: true,
  company: { select: { id: true, name: true } },
} satisfies Prisma.EstimateInclude;

interface Refs {
  companyId: string | null;
  contactId: string | null;
  recipientUserId: string | null;
  projectId: string | null;
  ticketId: string | null;
}

function blank(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

@Injectable()
export class EstimatesService {
  constructor(
    private prisma: PrismaService,
    private settings: ServiceSettingsService,
    private audit: AuditService,
    private taxRates: TaxRatesService,
    private notifications: EstimateNotificationsService,
  ) {}

  // ─── Reads ───

  async list(orgId: string, q: EstimateListQueryDto) {
    const { page = 1, limit = 20 } = q;
    const where: Prisma.EstimateWhereInput = { organizationId: orgId };
    if (q.status) where.status = q.status;
    else if (q.group === "open") where.status = { in: ["sent", "viewed", "changes_requested"] };
    else where.status = { not: "superseded" };
    if (q.companyId) where.companyId = q.companyId;
    const search = q.search?.trim();
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { number: { contains: search, mode: "insensitive" } },
        { company: { name: { contains: search, mode: "insensitive" } } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.estimate.findMany({
        where,
        include: estimateDetailInclude,
        orderBy: { createdAt: "desc" },
        ...paginationArgs(page, limit),
      }),
      this.prisma.estimate.count({ where }),
    ]);
    const names = await this.userNames(rows.map((r) => r.recipientUserId));
    const data = rows.map((r) => {
      const lines = sortLines(r.lineItems);
      return {
        id: r.id,
        number: r.number,
        version: r.version,
        status: r.status,
        title: r.title,
        company: r.company,
        recipient: r.recipientUserId ? { id: r.recipientUserId, name: names.get(r.recipientUserId) ?? null } : null,
        validUntil: r.validUntil,
        sentAt: r.sentAt,
        createdAt: r.createdAt,
        totals: estimateTotals(lines, r),
      };
    });
    return paginatedResponse(data, total, page, limit);
  }

  async findRaw(orgId: string, id: string) {
    const estimate = await this.prisma.estimate.findFirst({
      where: { id, organizationId: orgId },
      include: estimateDetailInclude,
    });
    if (!estimate) throw new NotFoundException("Estimate not found");
    return estimate;
  }

  async get(orgId: string, id: string) {
    const e = await this.findRaw(orgId, id);
    const [events, comments, versions, project, ticket] = await Promise.all([
      this.prisma.estimateEvent.findMany({ where: { estimateId: id }, orderBy: { createdAt: "asc" } }),
      this.prisma.estimateComment.findMany({ where: { estimateId: id }, orderBy: { createdAt: "asc" } }),
      this.prisma.estimate.findMany({
        where: { organizationId: orgId, rootId: e.rootId ?? e.id },
        select: { id: true, version: true, status: true, createdAt: true, sentAt: true },
        orderBy: { version: "asc" },
      }),
      e.projectId
        ? this.prisma.project.findFirst({ where: { id: e.projectId, organizationId: orgId }, select: { id: true, name: true } })
        : null,
      e.ticketId
        ? this.prisma.ticket.findFirst({
            where: { id: e.ticketId, organizationId: orgId },
            select: { id: true, number: true, subject: true },
          })
        : null,
    ]);
    const names = await this.userNames([
      e.recipientUserId,
      e.acceptedById,
      e.createdById,
      ...events.map((ev) => ev.actorId),
      ...comments.map((c) => c.authorId),
    ]);
    const invoices = await this.prisma.invoice.findMany({
      where: { organizationId: orgId, estimateId: id },
      select: { id: true, invoiceNumber: true, status: true, projectId: true },
      orderBy: { invoiceNumber: "asc" },
    });
    return {
      ...serializeForStaff(e),
      signatureKey: undefined,
      hasSignature: !!e.signatureKey,
      recipient: e.recipientUserId ? { id: e.recipientUserId, name: names.get(e.recipientUserId) ?? null } : null,
      project,
      ticket,
      versions,
      invoices,
      events: events.map((ev) => ({ ...ev, actorName: ev.actorId ? (names.get(ev.actorId) ?? null) : null })),
      comments: comments.map((c) => ({ ...c, authorName: names.get(c.authorId) ?? null })),
    };
  }

  async userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // ─── Writes ───

  /** Checks every referenced id against this workspace and derives the client contact. */
  private async resolveRefs(orgId: string, dto: EstimateBodyDto): Promise<Refs> {
    let companyId = blank(dto.companyId);
    const recipientUserId = blank(dto.recipientUserId);
    const projectId = blank(dto.projectId);
    const ticketId = blank(dto.ticketId);
    let contactId: string | null = null;

    if (companyId) {
      const company = await this.prisma.company.findFirst({ where: { id: companyId, organizationId: orgId }, select: { id: true } });
      if (!company) throw new BadRequestException("Company not found");
    }
    if (recipientUserId) {
      const member = await this.prisma.member.findFirst({
        where: { organizationId: orgId, userId: recipientUserId },
        select: { role: true },
      });
      if (!member || member.role !== "member") {
        throw new BadRequestException("The recipient must be a portal client of this workspace");
      }
      const contact = await this.prisma.contact.findFirst({
        where: { organizationId: orgId, userId: recipientUserId },
        select: { id: true, companyId: true },
      });
      if (companyId) {
        if (!contact || contact.companyId !== companyId) {
          throw new BadRequestException("The recipient is not a contact of the selected company");
        }
      } else if (contact?.companyId) {
        // A client who belongs to a company is quoted as that company.
        companyId = contact.companyId;
      }
      contactId = contact?.id ?? null;
    }
    if (projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: orgId }, select: { id: true } });
      if (!project) throw new BadRequestException("Project not found");
    }
    if (ticketId) {
      const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, organizationId: orgId }, select: { id: true } });
      if (!ticket) throw new BadRequestException("Ticket not found");
    }
    return { companyId, contactId, recipientUserId, projectId, ticketId };
  }

  private async lineData(orgId: string, lines: EstimateLineDto[]): Promise<Prisma.EstimateLineItemCreateManyEstimateInput[]> {
    const ids = [...new Set(lines.map((l) => l.catalogItemId).filter((x): x is string => !!x))];
    const known = ids.length
      ? new Set(
          (
            await this.prisma.catalogItem.findMany({ where: { id: { in: ids }, organizationId: orgId }, select: { id: true } })
          ).map((c) => c.id),
        )
      : new Set<string>();
    return lines.map((l, order) => {
      const taxable = l.taxable ?? true;
      const optional = !!l.optional;
      return {
        catalogItemId: l.catalogItemId && known.has(l.catalogItemId) ? l.catalogItemId : null,
        group: blank(l.group),
        name: l.name.trim(),
        description: blank(l.description),
        unit: l.unit?.trim() || (l.billingType === "hourly" ? "hour" : "each"),
        billingType: l.billingType,
        recurringInterval: l.billingType === "recurring" ? (l.recurringInterval ?? "monthly") : null,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        costCents: l.costCents ?? null,
        taxable,
        taxRateBps: taxable ? (l.taxRateBps ?? 0) : 0,
        optional,
        selected: optional ? (l.selected ?? true) : true,
        order,
      };
    });
  }

  private discountFields(dto: EstimateBodyDto) {
    const discountType = dto.discountType && dto.discountValue ? dto.discountType : null;
    let discountValue = discountType ? (dto.discountValue ?? null) : null;
    if (discountType === "percent" && discountValue != null) discountValue = Math.min(discountValue, 10000);
    return { discountType, discountValue, depositPercent: dto.depositPercent || null };
  }

  async create(orgId: string, userId: string, dto: EstimateBodyDto) {
    const refs = await this.resolveRefs(orgId, dto);
    const lines = await this.lineData(orgId, dto.lineItems);
    const settings = await this.settings.get(orgId);
    const validUntil = dto.validUntil ? new Date(dto.validUntil) : new Date(Date.now() + settings.estimateValidDays * DAY_MS);
    const terms = dto.terms === undefined ? settings.estimateDefaultTerms : blank(dto.terms);

    const created = await this.prisma.$transaction(async (tx) => {
      const { number, prefix } = await this.settings.nextNumber(orgId, "estimate", tx);
      const estimate = await tx.estimate.create({
        data: {
          organizationId: orgId,
          number: formatReference(prefix, number),
          version: 1,
          status: "draft",
          title: dto.title.trim(),
          introduction: blank(dto.introduction),
          ...refs,
          ...this.discountFields(dto),
          assumptions: blank(dto.assumptions),
          exclusions: blank(dto.exclusions),
          terms,
          validUntil,
          aiDrafted: !!dto.aiDrafted,
          createdById: userId,
          lineItems: { createMany: { data: lines } },
        },
      });
      await tx.estimate.update({ where: { id: estimate.id }, data: { rootId: estimate.id } });
      await tx.estimateEvent.create({ data: { estimateId: estimate.id, actorId: userId, action: "created" } });
      return estimate;
    });
    return this.get(orgId, created.id);
  }

  async update(orgId: string, id: string, dto: EstimateBodyDto) {
    const existing = await this.findRaw(orgId, id);
    if (!inList(EDITABLE_STATUSES, existing.status)) {
      throw new BadRequestException("Only draft estimates can be edited. Create a revision instead.");
    }
    const refs = await this.resolveRefs(orgId, dto);
    const lines = await this.lineData(orgId, dto.lineItems);
    await this.prisma.$transaction(async (tx) => {
      await tx.estimateLineItem.deleteMany({ where: { estimateId: id } });
      await tx.estimate.update({
        where: { id },
        data: {
          title: dto.title.trim(),
          introduction: blank(dto.introduction),
          ...refs,
          ...this.discountFields(dto),
          assumptions: blank(dto.assumptions),
          exclusions: blank(dto.exclusions),
          terms: blank(dto.terms),
          validUntil: dto.validUntil ? new Date(dto.validUntil) : existing.validUntil,
          aiDrafted: existing.aiDrafted || !!dto.aiDrafted,
          lineItems: { createMany: { data: lines } },
        },
      });
    });
    return this.get(orgId, id);
  }

  async send(orgId: string, id: string, userId: string, req?: AuditRequestContext) {
    const e = await this.findRaw(orgId, id);
    if (!inList(SENDABLE_STATUSES, e.status)) {
      throw new BadRequestException(`An estimate that is ${e.status.replace("_", " ")} can't be sent`);
    }
    if (!e.recipientUserId) throw new BadRequestException("Choose a recipient before sending");
    if (e.lineItems.length === 0) throw new BadRequestException("Add at least one line item before sending");
    const settings = await this.settings.get(orgId);
    let validUntil = e.validUntil;
    if (!validUntil || validUntil.getTime() < Date.now()) {
      validUntil = new Date(Date.now() + settings.estimateValidDays * DAY_MS);
    }
    const now = new Date();
    const sent = await this.prisma.$transaction(async (tx) => {
      // Guarded transition: a concurrent send of the same estimate updates nothing.
      const { count } = await tx.estimate.updateMany({
        where: { id, organizationId: orgId, status: { in: [...SENDABLE_STATUSES] } },
        data: { status: "sent", sentAt: now, validUntil, expiryReminderSentAt: null },
      });
      if (count === 0) throw new ConflictException("The estimate was changed by someone else");
      // Earlier open versions are replaced by this one.
      const superseded = await tx.estimate.updateMany({
        where: {
          organizationId: orgId,
          rootId: e.rootId ?? e.id,
          version: { lt: e.version },
          status: { in: ["draft", "sent", "viewed", "changes_requested", "declined", "expired"] },
        },
        data: { status: "superseded" },
      });
      await tx.estimateEvent.create({
        data: {
          estimateId: id,
          actorId: userId,
          action: "sent",
          detail: superseded.count > 0 ? `Replaces ${superseded.count} earlier version(s)` : null,
        },
      });
      return tx.estimate.findUniqueOrThrow({ where: { id }, include: estimateDetailInclude });
    });
    const totals = estimateTotals(sent.lineItems, sent);
    await this.audit.record({
      organizationId: orgId,
      actorId: userId,
      action: "estimate.sent",
      targetType: "estimate",
      targetId: id,
      summary: `Sent estimate ${sent.number} v${sent.version}`,
      metadata: { totalCents: totals.totalCents },
      ...auditContext(req),
    });
    this.notifications.notifySent(sent, totals.totalCents, userId);
    return this.get(orgId, id);
  }

  /** A brand-new estimate (new number) with the same content. */
  async duplicate(orgId: string, id: string, userId: string) {
    const e = await this.findRaw(orgId, id);
    const settings = await this.settings.get(orgId);
    const copy = await this.prisma.$transaction(async (tx) => {
      const { number, prefix } = await this.settings.nextNumber(orgId, "estimate", tx);
      const created = await tx.estimate.create({
        data: {
          ...this.copyFields(e),
          number: formatReference(prefix, number),
          version: 1,
          validUntil: new Date(Date.now() + settings.estimateValidDays * DAY_MS),
          createdById: userId,
        },
      });
      await tx.estimate.update({ where: { id: created.id }, data: { rootId: created.id } });
      await tx.estimateEvent.create({
        data: { estimateId: created.id, actorId: userId, action: "created", detail: `Duplicated from ${e.number}` },
      });
      return created;
    });
    return this.get(orgId, copy.id);
  }

  /** A new draft version with the same number; it supersedes this one when sent. */
  async revise(orgId: string, id: string, userId: string) {
    const e = await this.findRaw(orgId, id);
    if (!inList(REVISABLE_STATUSES, e.status)) {
      throw new BadRequestException(`An estimate that is ${e.status.replace("_", " ")} can't be revised`);
    }
    const rootId = e.rootId ?? e.id;
    const latest = await this.prisma.estimate.findFirst({
      where: { organizationId: orgId, rootId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, status: true },
    });
    if (latest && latest.id !== e.id) {
      throw new ConflictException(`Version ${latest.version} already exists; revise that one instead`);
    }
    const settings = await this.settings.get(orgId);
    const validUntil =
      e.validUntil && e.validUntil.getTime() > Date.now() ? e.validUntil : new Date(Date.now() + settings.estimateValidDays * DAY_MS);
    try {
      const revision = await this.prisma.$transaction(async (tx) => {
        const created = await tx.estimate.create({
          data: {
            ...this.copyFields(e),
            number: e.number,
            version: e.version + 1,
            rootId,
            validUntil,
            createdById: userId,
          },
        });
        await tx.estimateEvent.createMany({
          data: [
            { estimateId: created.id, actorId: userId, action: "created", detail: `Revision of version ${e.version}` },
            { estimateId: e.id, actorId: userId, action: "revised", detail: `Version ${e.version + 1} drafted` },
          ],
        });
        return created;
      });
      return this.get(orgId, revision.id);
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "P2002") {
        throw new ConflictException("A newer version already exists");
      }
      throw err;
    }
  }

  private copyFields(e: Awaited<ReturnType<EstimatesService["findRaw"]>>) {
    return {
      organizationId: e.organizationId,
      status: "draft",
      title: e.title,
      introduction: e.introduction,
      companyId: e.companyId,
      contactId: e.contactId,
      recipientUserId: e.recipientUserId,
      projectId: e.projectId,
      ticketId: e.ticketId,
      currency: e.currency,
      discountType: e.discountType,
      discountValue: e.discountValue,
      depositPercent: e.depositPercent,
      assumptions: e.assumptions,
      exclusions: e.exclusions,
      terms: e.terms,
      aiDrafted: e.aiDrafted,
      lineItems: {
        createMany: {
          data: sortLines(e.lineItems).map((l) => ({
            catalogItemId: l.catalogItemId,
            group: l.group,
            name: l.name,
            description: l.description,
            unit: l.unit,
            billingType: l.billingType,
            recurringInterval: l.recurringInterval,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            costCents: l.costCents,
            taxable: l.taxable,
            taxRateBps: l.taxRateBps,
            optional: l.optional,
            selected: l.selected,
            order: l.order,
          })),
        },
      },
    } satisfies Partial<Prisma.EstimateUncheckedCreateInput>;
  }

  async remove(orgId: string, id: string, userId: string, req?: AuditRequestContext): Promise<void> {
    const e = await this.findRaw(orgId, id);
    if (e.status !== "draft") throw new BadRequestException("Only draft estimates can be deleted");
    const { count } = await this.prisma.estimate.deleteMany({ where: { id, organizationId: orgId, status: "draft" } });
    if (count === 0) throw new ConflictException("The estimate is no longer a draft");
    await this.audit.record({
      organizationId: orgId,
      actorId: userId,
      action: "estimate.deleted",
      targetType: "estimate",
      targetId: id,
      summary: `Deleted draft estimate ${e.number} v${e.version}`,
      ...auditContext(req),
    });
  }

  async addComment(orgId: string, id: string, userId: string, dto: EstimateCommentDto) {
    const e = await this.findRaw(orgId, id);
    const comment = await this.prisma.estimateComment.create({
      data: { estimateId: id, authorId: userId, content: dto.content.trim() },
    });
    if (inList(["sent", "viewed", "changes_requested", "accepted", "declined", "expired", "converted"], e.status)) {
      this.notifications.notifyStaffComment(e);
    }
    return comment;
  }

  // ─── Settings ───

  async getSettings(orgId: string) {
    const s = await this.settings.get(orgId);
    return {
      estimatePrefix: s.estimatePrefix,
      nextEstimateNumber: s.nextEstimateNumber,
      estimateValidDays: s.estimateValidDays,
      estimateDefaultTerms: s.estimateDefaultTerms,
      aiAssistEnabled: s.aiAssistEnabled,
      defaultTaxRateBps: await this.taxRates.defaultRateBps(orgId),
    };
  }

  async updateSettings(orgId: string, dto: EstimateSettingsDto) {
    const prefix = dto.estimatePrefix?.trim().toUpperCase();
    if (prefix !== undefined && !/^[A-Z0-9]{1,10}$/.test(prefix)) {
      throw new BadRequestException("The prefix may only contain letters and digits");
    }
    await this.settings.update(orgId, {
      estimatePrefix: prefix,
      estimateValidDays: dto.estimateValidDays,
      estimateDefaultTerms: dto.estimateDefaultTerms === undefined ? undefined : blank(dto.estimateDefaultTerms),
      aiAssistEnabled: dto.aiAssistEnabled,
    });
    return this.getSettings(orgId);
  }
}
