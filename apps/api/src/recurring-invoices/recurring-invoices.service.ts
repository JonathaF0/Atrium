import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, RecurringInvoice, RecurringInvoiceItem } from "@atrium/database";
import { lineTaxCents } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, auditContext, type AuditRequestContext } from "../service-core";
import { paginatedResponse, paginationArgs } from "../common";
import type { CreateRecurringInvoiceDto, RecurringItemDto, RecurringListQueryDto, UpdateRecurringInvoiceDto } from "./recurring-invoices.dto";
import { RecurringGeneratorService } from "./recurring-generator.service";
import { RecurringStripeService } from "./recurring-stripe.service";
import { visibleScheduleIds } from "./recurring-visibility";
import { skipMissedRuns, startOfUtcDay, upcomingRuns } from "./schedule";

export interface Actor {
  id: string;
  email?: string | null;
}

type ScheduleWithItems = RecurringInvoice & { items: RecurringInvoiceItem[] };

const PREVIEW_RUNS = 6;

export function scheduleTotals(items: Array<{ quantity: number; unitPrice: number; taxRateBps: number }>): {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
} {
  let subtotalCents = 0;
  let taxCents = 0;
  for (const item of items) {
    subtotalCents += item.quantity * item.unitPrice;
    taxCents += lineTaxCents(item.quantity, item.unitPrice, item.taxRateBps);
  }
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** A date-only value ("2026-03-15") or timestamp, normalised to the start of its UTC day. */
function parseDay(value: string): Date {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException("Invalid date");
  return startOfUtcDay(date);
}

function itemRows(items: RecurringItemDto[]): Prisma.RecurringInvoiceItemCreateWithoutRecurringInvoiceInput[] {
  return items.map((item, order) => ({
    description: item.description.trim(),
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxRateBps: item.taxRateBps ?? 0,
    order,
  }));
}

@Injectable()
export class RecurringInvoicesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private generator: RecurringGeneratorService,
    private stripe: RecurringStripeService,
  ) {}

  // ── Staff ──

  async list(orgId: string, query: RecurringListQueryDto) {
    const { page = 1, limit = 20 } = query;
    const where: Prisma.RecurringInvoiceWhereInput = { organizationId: orgId };
    if (query.status) where.status = query.status;
    if (query.companyId) where.companyId = query.companyId;
    const [rows, total] = await Promise.all([
      this.prisma.recurringInvoice.findMany({
        where,
        include: { items: { orderBy: { order: "asc" } }, company: { select: { id: true, name: true } } },
        orderBy: [{ status: "asc" }, { nextRunAt: "asc" }],
        ...paginationArgs(page, limit),
      }),
      this.prisma.recurringInvoice.count({ where }),
    ]);
    return paginatedResponse(rows.map((r) => this.present(r)), total, page, limit);
  }

  async get(id: string, orgId: string) {
    const schedule = await this.prisma.recurringInvoice.findFirst({
      where: { id, organizationId: orgId },
      include: { items: { orderBy: { order: "asc" } }, company: { select: { id: true, name: true } } },
    });
    if (!schedule) throw new NotFoundException("Recurring invoice not found");
    const [invoices, recipient, project] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { organizationId: orgId, recurringInvoiceId: id },
        include: { lineItems: true },
        orderBy: { createdAt: "desc" },
        take: 24,
      }),
      schedule.recipientUserId
        ? this.prisma.user.findUnique({ where: { id: schedule.recipientUserId }, select: { id: true, name: true, email: true } })
        : null,
      schedule.projectId
        ? this.prisma.project.findFirst({ where: { id: schedule.projectId, organizationId: orgId }, select: { id: true, name: true } })
        : null,
    ]);
    return { ...this.present(schedule), recipient, project, invoices };
  }

  private present(schedule: ScheduleWithItems & { company?: { id: string; name: string } | null }) {
    const { stripeCustomerId, stripePaymentMethodId, ...rest } = schedule;
    const upcoming =
      schedule.status === "active"
        ? upcomingRuns(schedule, schedule.nextRunAt, schedule.lastRunAt === null, PREVIEW_RUNS).map((p) => ({
            runAt: p.start.toISOString(),
            periodEnd: p.end.toISOString(),
            factor: p.factor,
          }))
        : [];
    return {
      ...rest,
      hasCustomer: !!stripeCustomerId,
      hasCard: !!stripePaymentMethodId,
      totals: scheduleTotals(schedule.items),
      upcoming,
    };
  }

  /** Checks every referenced record belongs to this workspace, and the recipient to the company. */
  private async validateRefs(
    orgId: string,
    refs: { companyId: string | null; recipientUserId: string | null; projectId: string | null },
  ): Promise<void> {
    if (!refs.recipientUserId && !refs.projectId) {
      throw new BadRequestException("Choose a client to bill or a project");
    }
    if (refs.companyId) {
      const company = await this.prisma.company.findFirst({ where: { id: refs.companyId, organizationId: orgId }, select: { id: true } });
      if (!company) throw new BadRequestException("Company not found");
    }
    if (refs.projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: refs.projectId, organizationId: orgId }, select: { id: true } });
      if (!project) throw new BadRequestException("Project not found");
    }
    if (refs.recipientUserId) {
      const member = await this.prisma.member.findFirst({
        where: { organizationId: orgId, userId: refs.recipientUserId },
        select: { role: true },
      });
      if (!member || member.role !== "member") throw new BadRequestException("The recipient must be a portal client of this workspace");
      if (refs.companyId) {
        const contact = await this.prisma.contact.findFirst({
          where: { organizationId: orgId, userId: refs.recipientUserId, companyId: refs.companyId },
          select: { id: true },
        });
        if (!contact) throw new BadRequestException("The recipient is not a contact of that company");
      }
    }
  }

  async create(dto: CreateRecurringInvoiceDto, orgId: string, actor: Actor, req?: AuditRequestContext) {
    const refs = {
      companyId: dto.companyId || null,
      recipientUserId: dto.recipientUserId || null,
      projectId: dto.projectId || null,
    };
    await this.validateRefs(orgId, refs);
    const startDate = parseDay(dto.startDate);
    const endDate = dto.endDate ? parseDay(dto.endDate) : null;
    if (endDate && endDate.getTime() < startDate.getTime()) throw new BadRequestException("The end date is before the start date");

    const schedule = await this.prisma.recurringInvoice.create({
      data: {
        organizationId: orgId,
        name: dto.name.trim(),
        ...refs,
        interval: dto.interval,
        intervalCount: dto.intervalCount ?? 1,
        startDate,
        endDate,
        nextRunAt: startDate,
        dueDays: dto.dueDays ?? 14,
        prorateFirst: dto.prorateFirst ?? false,
        autoSend: dto.autoSend ?? true,
        autoCharge: dto.autoCharge ?? false,
        notes: dto.notes?.trim() || null,
        items: { create: itemRows(dto.items) },
      },
      include: { items: { orderBy: { order: "asc" } } },
    });
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "recurring_invoice.created",
      targetType: "recurring_invoice",
      targetId: schedule.id,
      summary: `Created recurring invoice "${schedule.name}"`,
      metadata: { interval: schedule.interval, intervalCount: schedule.intervalCount, totalCents: scheduleTotals(schedule.items).totalCents },
      ...auditContext(req),
    });
    return this.present(schedule);
  }

  async update(id: string, dto: UpdateRecurringInvoiceDto, orgId: string, actor: Actor, req?: AuditRequestContext) {
    const existing = await this.prisma.recurringInvoice.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException("Recurring invoice not found");

    const refs = {
      companyId: dto.companyId !== undefined ? dto.companyId || null : existing.companyId,
      recipientUserId: dto.recipientUserId !== undefined ? dto.recipientUserId || null : existing.recipientUserId,
      projectId: dto.projectId !== undefined ? dto.projectId || null : existing.projectId,
    };
    if (dto.companyId !== undefined || dto.recipientUserId !== undefined || dto.projectId !== undefined) {
      await this.validateRefs(orgId, refs);
    }

    const hasRun = existing.lastRunAt !== null;
    const startDate = dto.startDate ? parseDay(dto.startDate) : existing.startDate;
    if (hasRun && dto.startDate && startDate.getTime() !== existing.startDate.getTime()) {
      throw new BadRequestException("The start date cannot change after the first invoice was generated");
    }
    const endDate = dto.endDate === undefined ? existing.endDate : dto.endDate ? parseDay(dto.endDate) : null;
    if (endDate && endDate.getTime() < startDate.getTime()) throw new BadRequestException("The end date is before the start date");

    const timing = {
      interval: dto.interval ?? existing.interval,
      intervalCount: dto.intervalCount ?? existing.intervalCount,
      startDate,
      prorateFirst: dto.prorateFirst ?? existing.prorateFirst,
    };
    // Before the first run the schedule simply starts on its (new) start date;
    // afterwards timing changes apply from the next run.
    let nextRunAt = hasRun ? existing.nextRunAt : startDate;

    let status = existing.status;
    let action = "recurring_invoice.updated";
    if (dto.status && dto.status !== existing.status) {
      status = dto.status;
      if (dto.status === "paused") action = "recurring_invoice.paused";
      else if (dto.status === "ended") action = "recurring_invoice.ended";
      else {
        action = "recurring_invoice.resumed";
        if (endDate && endDate.getTime() < startOfUtcDay(new Date()).getTime()) {
          throw new BadRequestException("The schedule's end date has passed");
        }
        // Periods that passed while paused are not billed.
        nextRunAt = skipMissedRuns(timing, nextRunAt, !hasRun, new Date());
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.items) await tx.recurringInvoiceItem.deleteMany({ where: { recurringInvoiceId: id } });
      return tx.recurringInvoice.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          ...refs,
          interval: timing.interval,
          intervalCount: timing.intervalCount,
          startDate,
          endDate,
          nextRunAt,
          dueDays: dto.dueDays,
          prorateFirst: timing.prorateFirst,
          autoSend: dto.autoSend,
          autoCharge: dto.autoCharge,
          notes: dto.notes === undefined ? undefined : dto.notes?.trim() || null,
          status,
          ...(dto.items ? { items: { create: itemRows(dto.items) } } : {}),
        },
        include: { items: { orderBy: { order: "asc" } } },
      });
    });

    const changed = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action,
      targetType: "recurring_invoice",
      targetId: id,
      summary: `${action.split(".")[1].replace(/^\w/, (c) => c.toUpperCase())} recurring invoice "${updated.name}"`,
      metadata: { fields: changed, ...(dto.autoCharge !== undefined ? { autoCharge: dto.autoCharge } : {}) },
      ...auditContext(req),
    });
    return this.present(updated);
  }

  async remove(id: string, orgId: string, actor: Actor, req?: AuditRequestContext): Promise<void> {
    const existing = await this.prisma.recurringInvoice.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException("Recurring invoice not found");
    const generated = await this.prisma.invoice.count({ where: { organizationId: orgId, recurringInvoiceId: id } });
    // Clients reach project-less invoices through their schedule, so keep it.
    if (generated > 0) {
      throw new BadRequestException("This schedule has generated invoices. End it instead of deleting it.");
    }
    await this.prisma.recurringInvoice.delete({ where: { id } });
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "recurring_invoice.deleted",
      targetType: "recurring_invoice",
      targetId: id,
      summary: `Deleted recurring invoice "${existing.name}"`,
      ...auditContext(req),
    });
  }

  async runNow(id: string, orgId: string, actor: Actor) {
    const existing = await this.prisma.recurringInvoice.findFirst({ where: { id, organizationId: orgId }, select: { status: true } });
    if (!existing) throw new NotFoundException("Recurring invoice not found");
    if (existing.status !== "active") throw new BadRequestException("Only an active schedule can run");
    const run = await this.generator.generate(id, new Date(), { force: true, actorId: actor.id });
    if (!run) throw new ConflictException("This schedule is already running. Try again in a moment.");
    if (!run.invoiceId) throw new BadRequestException("The schedule has reached its end date");
    return { invoiceId: run.invoiceId, invoiceNumber: run.invoiceNumber, ended: run.ended };
  }

  /** Pickers for the schedule editor: companies, portal clients (with their company) and projects. */
  async options(orgId: string) {
    const [companies, members, projects] = await Promise.all([
      this.prisma.company.findMany({ where: { organizationId: orgId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 1000 }),
      this.prisma.member.findMany({
        where: { organizationId: orgId, role: "member" },
        select: { userId: true, user: { select: { name: true, email: true } } },
        take: 2000,
      }),
      this.prisma.project.findMany({
        where: { organizationId: orgId, archivedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 1000,
      }),
    ]);
    const contacts = await this.prisma.contact.findMany({
      where: { organizationId: orgId, userId: { in: members.map((m) => m.userId) } },
      select: { userId: true, companyId: true },
    });
    const companyOf = new Map(contacts.map((c) => [c.userId, c.companyId]));
    return {
      companies,
      projects,
      clients: members
        .map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, companyId: companyOf.get(m.userId) ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // ── Portal ──

  private async findVisible(id: string, userId: string, orgId: string) {
    const ids = await visibleScheduleIds(this.prisma, userId, orgId);
    if (!ids.includes(id)) throw new NotFoundException("Plan not found");
    const schedule = await this.prisma.recurringInvoice.findFirst({ where: { id, organizationId: orgId, status: { in: ["active", "paused"] } } });
    if (!schedule) throw new NotFoundException("Plan not found");
    return schedule;
  }

  async listMine(userId: string, orgId: string) {
    const ids = await visibleScheduleIds(this.prisma, userId, orgId);
    if (ids.length === 0) return { data: [], paymentsAvailable: false };
    const [rows, paymentsAvailable] = await Promise.all([
      this.prisma.recurringInvoice.findMany({
        where: { id: { in: ids }, organizationId: orgId, status: { in: ["active", "paused"] } },
        include: { items: { orderBy: { order: "asc" } }, company: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
      }),
      this.stripe.isAvailable(orgId),
    ]);
    return {
      paymentsAvailable,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        interval: r.interval,
        intervalCount: r.intervalCount,
        nextRunAt: r.status === "active" ? r.nextRunAt : null,
        endDate: r.endDate,
        companyName: r.company?.name ?? null,
        autoCharge: r.autoCharge,
        hasCard: !!r.stripePaymentMethodId,
        items: r.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, taxRateBps: i.taxRateBps })),
        totals: scheduleTotals(r.items),
      })),
    };
  }

  async startCardSetup(id: string, userId: string, orgId: string) {
    const schedule = await this.findVisible(id, userId, orgId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user) throw new NotFoundException("User not found");
    return this.stripe.startCardSetup(schedule, user);
  }

  async confirmCardSetup(id: string, sessionId: string, actor: Actor, orgId: string, req?: AuditRequestContext) {
    const schedule = await this.findVisible(id, actor.id, orgId);
    const paymentMethodId = await this.stripe.confirmCardSetup(schedule, sessionId);
    await this.prisma.recurringInvoice.update({ where: { id }, data: { stripePaymentMethodId: paymentMethodId } });
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "recurring_invoice.card_saved",
      targetType: "recurring_invoice",
      targetId: id,
      summary: `Saved a card for "${schedule.name}"`,
      ...auditContext(req),
    });
    return { hasCard: true };
  }

  async removeCard(id: string, actor: Actor, orgId: string, req?: AuditRequestContext) {
    const schedule = await this.findVisible(id, actor.id, orgId);
    await this.prisma.recurringInvoice.update({ where: { id }, data: { stripePaymentMethodId: null } });
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "recurring_invoice.card_removed",
      targetType: "recurring_invoice",
      targetId: id,
      summary: `Removed the saved card for "${schedule.name}"`,
      ...auditContext(req),
    });
    return { hasCard: false };
  }
}
