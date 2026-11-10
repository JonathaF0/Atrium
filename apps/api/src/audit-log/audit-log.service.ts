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
    return paginatedResponse(await this.withActors(data), total, page, limit);
  }

  async exportRows(organizationId: string, filters: AuditFilters) {
    const rows = await this.prisma.auditLog.findMany({
      where: buildAuditWhere(organizationId, filters),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_LIMIT,
    });
    return this.withActors(rows);
  }

  /**
   * Adds the actor's current name, and their email where the entry didn't
   * record one (some modules store only the user id).
   */
  private async withActors<T extends { actorId: string | null; actorEmail: string | null }>(
    rows: T[],
  ): Promise<(T & { actorName: string | null })[]> {
    const ids: string[] = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => !!id))];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      const user = r.actorId ? byId.get(r.actorId) : undefined;
      return { ...r, actorName: user?.name ?? null, actorEmail: r.actorEmail ?? user?.email ?? null };
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

  /**
   * The action groups (the part before the first dot, e.g. "ticket") and target
   * types that occur in this workspace's log, for the viewer's filters. Derived
   * from the data so new modules show up without a hard-coded list.
   */
  async facets(organizationId: string): Promise<{ actionGroups: string[]; targetTypes: string[] }> {
    const [groups, types] = await Promise.all([
      this.prisma.$queryRaw<{ group: string }[]>`
        SELECT DISTINCT split_part("action", '.', 1) AS "group"
        FROM "audit_log" WHERE "organizationId" = ${organizationId}
        ORDER BY 1 LIMIT 200`,
      this.prisma.auditLog.findMany({
        where: { organizationId },
        distinct: ["targetType"],
        select: { targetType: true },
        orderBy: { targetType: "asc" },
        take: 200,
      }),
    ]);
    return {
      actionGroups: groups.map((g) => g.group).filter(Boolean),
      targetTypes: types.map((t) => t.targetType),
    };
  }

  /** Deletes entries older than the retention window. Returns how many were removed. */
  async prune(now: Date = new Date()): Promise<number> {
    const days = retentionDays(this.config.get<string>("AUDIT_LOG_RETENTION_DAYS"));
    if (days === 0) return 0;
    const { count } = await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - days * DAY_MS) } } });
    return count;
  }
}
