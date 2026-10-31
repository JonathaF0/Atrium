import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { paginatedResponse, paginationArgs } from "../common";
import type { AuditLogQueryDto } from "./audit-log.dto";

const DAY_MS = 86_400_000;
/** Rows a single CSV export may contain. */
export const EXPORT_LIMIT = 10_000;

export type AuditFilters = Omit<AuditLogQueryDto, "page" | "limit">;

/** A date-only "to" bound includes that whole day. */
function endOfRange(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(new Date(`${value}T00:00:00.000Z`).getTime() + DAY_MS) : new Date(value);
}

/** The Prisma filter for a workspace's audit log; the workspace always comes from the session. */
export function buildAuditWhere(organizationId: string, filters: AuditFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = { organizationId };
  if (filters.action) where.action = { startsWith: filters.action.toLowerCase() };
  if (filters.actorId) where.actorId = filters.actorId;
  if (filters.targetType) where.targetType = filters.targetType;
  if (filters.targetId) where.targetId = filters.targetId;
  const createdAt: Prisma.DateTimeFilter = {};
  if (filters.from) createdAt.gte = new Date(filters.from);
  if (filters.to) createdAt.lt = endOfRange(filters.to);
  if (createdAt.gte && createdAt.lt && createdAt.gte >= createdAt.lt) {
    throw new BadRequestException("The start date must be before the end date");
  }
  if (createdAt.gte || createdAt.lt) where.createdAt = createdAt;
  return where;
}

/** AUDIT_LOG_RETENTION_DAYS: default 365; 0 keeps entries forever. */
export function retentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 365;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 365;
}

@Injectable()
export class AuditLogService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async list(organizationId: string, query: AuditLogQueryDto) {
    const { page = 1, limit = 50 } = query;
    const where = buildAuditWhere(organizationId, query);
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...paginationArgs(page, limit),
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginatedResponse(data, total, page, limit);
  }

  exportRows(organizationId: string, filters: AuditFilters) {
    return this.prisma.auditLog.findMany({
      where: buildAuditWhere(organizationId, filters),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_LIMIT,
    });
  }

  /** People who appear in the workspace's log, for the actor filter. */
  async actors(organizationId: string) {
    const rows = await this.prisma.auditLog.groupBy({
      by: ["actorId", "actorEmail"],
      where: { organizationId, actorId: { not: null } },
      _count: true,
      orderBy: { _count: { actorId: "desc" } },
      take: 200,
    });
    const byId = new Map<string, string | null>();
    for (const row of rows) if (row.actorId && !byId.has(row.actorId)) byId.set(row.actorId, row.actorEmail);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...byId.keys()] } },
      select: { id: true, name: true, email: true },
    });
    const names = new Map(users.map((u) => [u.id, u]));
    return [...byId].map(([id, email]) => ({ id, name: names.get(id)?.name ?? null, email: names.get(id)?.email ?? email }));
  }

  /** Deletes entries older than the retention window. Returns how many were removed. */
  async prune(now: Date = new Date()): Promise<number> {
    const days = retentionDays(this.config.get<string>("AUDIT_LOG_RETENTION_DAYS"));
    if (days === 0) return 0;
    const { count } = await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - days * DAY_MS) } } });
    return count;
  }
}
