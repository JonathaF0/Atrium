import { Injectable } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import type { SlaTargets } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ALWAYS_OPEN } from "../service-core";
import type { BusinessCalendar } from "../service-core";
import { computeDueDates, parseTargets, slaOnStatusChange, toCalendar, type SlaClockState } from "./sla";

export interface LoadedPolicy {
  id: string;
  targets: SlaTargets;
  warnAtPercent: number;
  escalateToId: string | null;
  calendar: BusinessCalendar;
}

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class SlaService {
  constructor(private prisma: PrismaService) {}

  /**
   * Which policy applies: the category's, then an active contract of the
   * ticket's company that names one, then the workspace default.
   */
  async resolvePolicyId(
    organizationId: string,
    categoryId: string | null,
    companyId: string | null,
    db: Db = this.prisma,
  ): Promise<string | null> {
    if (categoryId) {
      const category = await db.ticketCategory.findFirst({
        where: { id: categoryId, organizationId },
        select: { slaPolicyId: true },
      });
      if (category?.slaPolicyId) return category.slaPolicyId;
    }
    if (companyId) {
      const now = new Date();
      const contract = await db.contract.findFirst({
        where: {
          organizationId,
          companyId,
          status: "active",
          slaPolicyId: { not: null },
          startsAt: { lte: now },
          OR: [{ endsAt: null }, { endsAt: { gte: now } }],
        },
        orderBy: { startsAt: "desc" },
        select: { slaPolicyId: true },
      });
      if (contract?.slaPolicyId) return contract.slaPolicyId;
    }
    const settings = await db.serviceSettings.findUnique({
      where: { organizationId },
      select: { defaultSlaPolicyId: true },
    });
    return settings?.defaultSlaPolicyId ?? null;
  }

  async load(policyId: string | null, organizationId: string, db: Db = this.prisma): Promise<LoadedPolicy | null> {
    if (!policyId) return null;
    const policy = await db.slaPolicy.findFirst({
      where: { id: policyId, organizationId },
      include: { businessHours: { include: { holidays: { select: { date: true } } } } },
    });
    if (!policy) return null;
    return {
      id: policy.id,
      targets: parseTargets(policy.targets),
      warnAtPercent: policy.warnAtPercent,
      escalateToId: policy.escalateToId,
      calendar: policy.businessHours ? toCalendar(policy.businessHours) : ALWAYS_OPEN,
    };
  }

  /** SLA fields for a new ticket. */
  async initial(
    organizationId: string,
    categoryId: string | null,
    companyId: string | null,
    priority: string,
    createdAt: Date,
    db: Db = this.prisma,
  ): Promise<{ slaPolicyId: string | null; firstResponseDueAt: Date | null; resolutionDueAt: Date | null }> {
    const policy = await this.load(await this.resolvePolicyId(organizationId, categoryId, companyId, db), organizationId, db);
    if (!policy) return { slaPolicyId: null, firstResponseDueAt: null, resolutionDueAt: null };
    return { slaPolicyId: policy.id, ...computeDueDates(createdAt, priority, policy.targets, 0, policy.calendar) };
  }

  /** Due dates after a priority or policy change, keeping the time already paused. */
  async recompute(
    ticket: SlaClockState & { organizationId: string; slaPolicyId: string | null },
    policyId: string | null,
    db: Db = this.prisma,
  ): Promise<{ slaPolicyId: string | null; firstResponseDueAt: Date | null; resolutionDueAt: Date | null; slaWarnedAt: null }> {
    const policy = await this.load(policyId, ticket.organizationId, db);
    if (!policy) return { slaPolicyId: null, firstResponseDueAt: null, resolutionDueAt: null, slaWarnedAt: null };
    return {
      slaPolicyId: policy.id,
      ...computeDueDates(ticket.createdAt, ticket.priority, policy.targets, ticket.slaPausedSeconds, policy.calendar),
      slaWarnedAt: null,
    };
  }

  async onStatusChange(
    ticket: SlaClockState & { organizationId: string; slaPolicyId: string | null },
    nextStatus: string,
    now: Date,
    db: Db = this.prisma,
  ): Promise<ReturnType<typeof slaOnStatusChange>> {
    const policy = await this.load(ticket.slaPolicyId, ticket.organizationId, db);
    return slaOnStatusChange(ticket, nextStatus, now, policy?.targets ?? null, policy?.calendar ?? ALWAYS_OPEN);
  }
}
