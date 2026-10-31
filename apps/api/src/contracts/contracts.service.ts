import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Contract, Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, ClientScopeService } from "../service-core";
import { paginatedResponse, paginationArgs } from "../common";
import type { Paginated } from "../common";
import { computeUsage, periodAt } from "./contract-period";
import type { Period, Usage } from "./contract-period";
import { isInForce, pickActiveContract } from "./contract-selection";
import type { CreateContractDto, ListContractsQueryDto, UpdateContractDto } from "./contracts.dto";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ContractActor {
  id: string | null;
  email?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ContractUsage extends Usage {
  period: { start: Date; end: Date | null; coveragePeriod: string };
}

/**
 * What the helpdesk applies to new work for a company: the SLA policy of the
 * company's contract in force, and whether time should default to non-billable
 * against that contract (only while it has covered minutes left this period).
 */
export interface Coverage {
  contract: { id: string; name: string; type: string; slaPolicyId: string | null } | null;
  slaPolicyId: string | null;
  usage: ContractUsage | null;
  hasHoursRemaining: boolean;
  defaultBillable: boolean;
  defaultContractId: string | null;
}

const LIST_INCLUDE = {
  company: { select: { id: true, name: true } },
  slaPolicy: { select: { id: true, name: true } },
} satisfies Prisma.ContractInclude;

type ContractWithRefs = Prisma.ContractGetPayload<{ include: typeof LIST_INCLUDE }>;

function parseDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} is not a valid date`);
  return d;
}

function cleanServices(list: string[] | undefined): string[] | undefined {
  if (!list) return undefined;
  const out: string[] = [];
  for (const s of list) {
    const t = s.trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

@Injectable()
export class ContractsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private clientScope: ClientScopeService,
  ) {}

  async list(
    orgId: string,
    query: ListContractsQueryDto,
    now: Date = new Date(),
  ): Promise<Paginated<ContractWithRefs & { usage: ContractUsage | null }>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ContractWhereInput = { organizationId: orgId };
    if (query.companyId) where.companyId = query.companyId;
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.endingWithinDays !== undefined) {
      where.endsAt = { gte: now, lte: new Date(now.getTime() + query.endingWithinDays * DAY_MS) };
    }
    const q = query.q?.trim();
    if (q) where.name = { contains: q, mode: "insensitive" };
    const [rows, total] = await Promise.all([
      this.prisma.contract.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: [{ status: "asc" }, { endsAt: { sort: "asc", nulls: "last" } }, { name: "asc" }, { id: "asc" }],
        ...paginationArgs(page, limit),
      }),
      this.prisma.contract.count({ where }),
    ]);
    const data = await Promise.all(
      rows.map(async (c) => ({ ...c, usage: c.coveredMinutes != null && isInForce(c, now) ? await this.usageOf(c, now) : null })),
    );
    return paginatedResponse(data, total, page, limit);
  }

  async get(orgId: string, id: string, now: Date = new Date()): Promise<ContractWithRefs & { usage: ContractUsage }> {
    const contract = await this.prisma.contract.findFirst({ where: { id, organizationId: orgId }, include: LIST_INCLUDE });
    if (!contract) throw new NotFoundException("Contract not found");
    return { ...contract, usage: await this.usageOf(contract, now) };
  }

  async create(orgId: string, dto: CreateContractDto, actor: ContractActor): Promise<Contract> {
    await this.assertCompany(orgId, dto.companyId);
    if (dto.slaPolicyId) await this.assertSlaPolicy(orgId, dto.slaPolicyId);
    const startsAt = parseDate(dto.startsAt, "startsAt");
    const endsAt = dto.endsAt ? parseDate(dto.endsAt, "endsAt") : null;
    this.assertTerm(startsAt, endsAt, dto.coveragePeriod);
    const contract = await this.prisma.contract.create({
      data: {
        organizationId: orgId,
        companyId: dto.companyId,
        name: dto.name.trim(),
        type: dto.type,
        status: dto.status,
        startsAt,
        endsAt,
        autoRenew: dto.autoRenew,
        renewalNoticeDays: dto.renewalNoticeDays,
        coveredMinutes: dto.coveredMinutes,
        coveragePeriod: dto.coveragePeriod,
        overageRateCents: dto.overageRateCents,
        includedServices: cleanServices(dto.includedServices),
        slaPolicyId: dto.slaPolicyId ?? null,
        documentUrl: dto.documentUrl ?? null,
        notes: dto.notes?.trim() || null,
      },
    });
    await this.record(orgId, actor, "contract.created", contract.id, `Created contract ${contract.name}`);
    return contract;
  }

  async update(orgId: string, id: string, dto: UpdateContractDto, actor: ContractActor): Promise<Contract> {
    const current = await this.prisma.contract.findFirst({ where: { id, organizationId: orgId } });
    if (!current) throw new NotFoundException("Contract not found");
    if (dto.slaPolicyId) await this.assertSlaPolicy(orgId, dto.slaPolicyId);
    const startsAt = dto.startsAt ? parseDate(dto.startsAt, "startsAt") : current.startsAt;
    const endsAt = dto.endsAt === undefined ? current.endsAt : dto.endsAt === null ? null : parseDate(dto.endsAt, "endsAt");
    this.assertTerm(startsAt, endsAt, dto.coveragePeriod ?? current.coveragePeriod);
    const termChanged =
      startsAt.getTime() !== current.startsAt.getTime() || (endsAt?.getTime() ?? null) !== (current.endsAt?.getTime() ?? null);
    const contract = await this.prisma.contract.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        type: dto.type,
        status: dto.status,
        startsAt,
        endsAt,
        autoRenew: dto.autoRenew,
        renewalNoticeDays: dto.renewalNoticeDays,
        coveredMinutes: dto.coveredMinutes,
        coveragePeriod: dto.coveragePeriod,
        overageRateCents: dto.overageRateCents,
        includedServices: cleanServices(dto.includedServices),
        slaPolicyId: dto.slaPolicyId,
        documentUrl: dto.documentUrl,
        notes: dto.notes === undefined ? undefined : dto.notes?.trim() || null,
        // A new end date is a new term: its renewal notice goes out again.
        ...(termChanged ? { renewalNotifiedAt: null } : {}),
      },
    });
    await this.record(orgId, actor, "contract.updated", id, `Updated contract ${contract.name}`, {
      fields: Object.keys(dto),
    });
    return contract;
  }

  async remove(orgId: string, id: string, actor: ContractActor): Promise<void> {
    const contract = await this.prisma.contract.findFirst({ where: { id, organizationId: orgId } });
    if (!contract) throw new NotFoundException("Contract not found");
    await this.prisma.$transaction([
      // TimeEntry.contractId is a plain column: release the entries so they aren't left pointing at nothing.
      this.prisma.timeEntry.updateMany({ where: { organizationId: orgId, contractId: id }, data: { contractId: null } }),
      this.prisma.recurringInvoice.updateMany({ where: { organizationId: orgId, contractId: id }, data: { contractId: null } }),
      this.prisma.contract.delete({ where: { id } }),
    ]);
    await this.record(orgId, actor, "contract.deleted", id, `Deleted contract ${contract.name}`);
  }

  async usage(orgId: string, id: string, at: Date = new Date()): Promise<ContractUsage> {
    const contract = await this.prisma.contract.findFirst({ where: { id, organizationId: orgId } });
    if (!contract) throw new NotFoundException("Contract not found");
    return this.usageOf(contract, at);
  }

  /** Time entries counted against the contract in the period containing `at`. */
  async timeEntries(orgId: string, id: string, at: Date = new Date()) {
    const contract = await this.prisma.contract.findFirst({ where: { id, organizationId: orgId } });
    if (!contract) throw new NotFoundException("Contract not found");
    const period = periodAt(contract, at);
    return this.prisma.timeEntry.findMany({
      where: { organizationId: orgId, contractId: id, startedAt: this.periodRange(period) },
      select: {
        id: true,
        description: true,
        startedAt: true,
        durationSec: true,
        billable: true,
        ticketId: true,
        project: { select: { id: true, name: true } },
        user: { select: { id: true, name: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 200,
    });
  }

  /** Recent finished, uninvoiced entries of this company's projects or tickets not yet on a contract. */
  async attachableTimeEntries(orgId: string, id: string, now: Date = new Date()) {
    const contract = await this.prisma.contract.findFirst({ where: { id, organizationId: orgId } });
    if (!contract) throw new NotFoundException("Contract not found");
    return this.prisma.timeEntry.findMany({
      where: {
        organizationId: orgId,
        contractId: null,
        invoiceLineItemId: null,
        endedAt: { not: null },
        startedAt: { gte: new Date(now.getTime() - 120 * DAY_MS) },
        OR: [
          { ticket: { companyId: contract.companyId } },
          {
            OR: [{ ticketId: null }, { ticket: { companyId: null } }],
            project: { contacts: { some: { contact: { companyId: contract.companyId } } } },
          },
        ],
      },
      select: {
        id: true,
        description: true,
        startedAt: true,
        durationSec: true,
        billable: true,
        project: { select: { id: true, name: true } },
        user: { select: { id: true, name: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 100,
    });
  }

  /**
   * Counts a time entry against the contract (non-billable) or, with `attach = false`,
   * takes it off again (billable). The entry must belong to the contract's company:
   * through its ticket's company, or else through a contact of that company on its project.
   */
  async setTimeEntry(orgId: string, contractId: string, timeEntryId: string, attach: boolean, actor: ContractActor) {
    const contract = await this.prisma.contract.findFirst({ where: { id: contractId, organizationId: orgId } });
    if (!contract) throw new NotFoundException("Contract not found");
    const entry = await this.prisma.timeEntry.findFirst({
      where: { id: timeEntryId, organizationId: orgId },
      select: { id: true, projectId: true, contractId: true, invoiceLineItemId: true, ticket: { select: { companyId: true } } },
    });
    if (!entry) throw new NotFoundException("Time entry not found");
    if (entry.invoiceLineItemId) throw new BadRequestException("This time entry is already invoiced");

    if (!attach) {
      if (entry.contractId !== contractId) throw new BadRequestException("This time entry is not on this contract");
      const updated = await this.prisma.timeEntry.update({
        where: { id: timeEntryId },
        data: { contractId: null, billable: true },
        select: { id: true, contractId: true, billable: true },
      });
      await this.record(orgId, actor, "contract.time_detached", contractId, `Took a time entry off contract ${contract.name}`, {
        timeEntryId,
      });
      return updated;
    }

    if (!(await this.entryBelongsToCompany(orgId, entry, contract.companyId))) {
      throw new BadRequestException("This time entry is not for the contract's company");
    }
    const updated = await this.prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: { contractId, billable: false },
      select: { id: true, contractId: true, billable: true },
    });
    await this.record(orgId, actor, "contract.time_attached", contractId, `Counted a time entry against contract ${contract.name}`, {
      timeEntryId,
    });
    return updated;
  }

  /** Covered-hours summary: each contract in force that includes hours, with this period's usage. */
  async coveredHours(orgId: string, now: Date = new Date()) {
    const contracts = await this.prisma.contract.findMany({
      where: {
        organizationId: orgId,
        status: "active",
        coveredMinutes: { not: null },
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      include: LIST_INCLUDE,
      orderBy: [{ company: { name: "asc" } }, { name: "asc" }],
      take: 500,
    });
    return Promise.all(contracts.map(async (c) => ({ ...c, usage: await this.usageOf(c, now) })));
  }

  slaPolicies(orgId: string): Promise<Array<{ id: string; name: string }>> {
    return this.prisma.slaPolicy.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 200,
    });
  }

  /** The company's contract in force at `at`, most specific first (see compareSpecificity). */
  async activeContractFor(orgId: string, companyId: string, at: Date = new Date()): Promise<Contract | null> {
    const contracts = await this.prisma.contract.findMany({
      where: {
        organizationId: orgId,
        companyId,
        status: "active",
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
      },
    });
    return pickActiveContract(contracts, at);
  }

  async coverageFor(orgId: string, companyId: string | null | undefined, at: Date = new Date()): Promise<Coverage> {
    const none: Coverage = {
      contract: null,
      slaPolicyId: null,
      usage: null,
      hasHoursRemaining: false,
      defaultBillable: true,
      defaultContractId: null,
    };
    if (!companyId) return none;
    const contract = await this.activeContractFor(orgId, companyId, at);
    if (!contract) return none;
    const usage = contract.coveredMinutes != null ? await this.usageOf(contract, at) : null;
    return coverageOf(contract, usage);
  }

  /** Portal: the company's contracts in force, for company admins only. */
  async mine(userId: string, orgId: string, now: Date = new Date()) {
    const scope = await this.clientScope.resolve(userId, orgId);
    if (!scope.companyAdmin || !scope.companyId) return [];
    const contracts = await this.prisma.contract.findMany({
      where: {
        organizationId: orgId,
        companyId: scope.companyId,
        status: "active",
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      orderBy: [{ startsAt: "desc" }, { id: "asc" }],
      take: 50,
    });
    return Promise.all(
      contracts.map(async (c) => {
        const usage = c.coveredMinutes != null ? await this.usageOf(c, now) : null;
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          autoRenew: c.autoRenew,
          includedServices: c.includedServices,
          coveragePeriod: c.coveragePeriod,
          coveredMinutes: c.coveredMinutes,
          usage: usage
            ? { period: usage.period, usedMinutes: usage.usedMinutes, remainingMinutes: usage.remainingMinutes }
            : null,
        };
      }),
    );
  }

  // ── helpers ──

  async usageOf(
    contract: Pick<Contract, "id" | "organizationId" | "startsAt" | "endsAt" | "coveragePeriod" | "coveredMinutes" | "overageRateCents">,
    at: Date,
  ): Promise<ContractUsage> {
    const period = periodAt(contract, at);
    const agg = await this.prisma.timeEntry.aggregate({
      where: { organizationId: contract.organizationId, contractId: contract.id, startedAt: this.periodRange(period) },
      _sum: { durationSec: true },
    });
    return {
      period: { start: period.start, end: period.end, coveragePeriod: contract.coveragePeriod },
      ...computeUsage(contract, agg._sum.durationSec ?? 0),
    };
  }

  private periodRange(period: Period): Prisma.DateTimeFilter {
    return period.end ? { gte: period.start, lt: period.end } : { gte: period.start };
  }

  private async entryBelongsToCompany(
    orgId: string,
    entry: { projectId: string; ticket: { companyId: string | null } | null },
    companyId: string,
  ): Promise<boolean> {
    if (entry.ticket?.companyId) return entry.ticket.companyId === companyId;
    const links = await this.prisma.projectContact.count({
      where: { projectId: entry.projectId, contact: { organizationId: orgId, companyId } },
    });
    return links > 0;
  }

  private assertTerm(startsAt: Date, endsAt: Date | null, coveragePeriod: string | undefined): void {
    if (endsAt && endsAt.getTime() <= startsAt.getTime()) throw new BadRequestException("endsAt must be after startsAt");
    if (coveragePeriod === "term" && !endsAt) {
      // An open-ended "term" period would count every hour ever logged against one allowance.
      throw new BadRequestException("A contract without an end date can't count hours per term");
    }
  }

  private async assertCompany(orgId: string, companyId: string): Promise<void> {
    const company = await this.prisma.company.findFirst({ where: { id: companyId, organizationId: orgId }, select: { id: true } });
    if (!company) throw new BadRequestException("Company not found");
  }

  private async assertSlaPolicy(orgId: string, slaPolicyId: string): Promise<void> {
    const policy = await this.prisma.slaPolicy.findFirst({ where: { id: slaPolicyId, organizationId: orgId }, select: { id: true } });
    if (!policy) throw new BadRequestException("SLA policy not found");
  }

  private record(
    orgId: string,
    actor: ContractActor,
    action: string,
    targetId: string,
    summary: string,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    return this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action,
      targetType: "contract",
      targetId,
      summary,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }
}

/** Pure part of coverageFor, for tests. */
export function coverageOf(
  contract: Pick<Contract, "id" | "name" | "type" | "slaPolicyId" | "coveredMinutes">,
  usage: ContractUsage | null,
): Coverage {
  const hasHoursRemaining = !!usage && usage.remainingMinutes !== null && usage.remainingMinutes > 0;
  return {
    contract: { id: contract.id, name: contract.name, type: contract.type, slaPolicyId: contract.slaPolicyId },
    slaPolicyId: contract.slaPolicyId,
    usage,
    hasHoursRemaining,
    defaultBillable: !hasHoursRemaining,
    defaultContractId: hasHoursRemaining ? contract.id : null,
  };
}
