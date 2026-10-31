import { Injectable } from "@nestjs/common";
import { Prisma } from "@atrium/database";
import { TICKET_PRIORITIES, TICKET_PRIORITY_LABELS } from "@atrium/shared";
import type { TicketPriority } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { formatReference } from "../service-core";
import { companyFilter, rangeInfo } from "./report-context.service";
import type { RangeInfo, ReportContext } from "./report-context.service";
import { zonedDayStart } from "./report-range";
import { bucketKeySql, hours, inRange, num, numOrNull, ts } from "./report-sql";
import { percent } from "./report-math";

// ─── Shapes ───

export interface VolumeRow {
  key: string | null;
  label: string;
  created: number;
  resolved: number;
}

export interface TicketVolumeReport {
  range: RangeInfo;
  totals: { created: number; resolved: number; backlog: number };
  series: { bucket: string; created: number; resolved: number; backlog: number }[];
  byCategory: VolumeRow[];
  byPriority: VolumeRow[];
  bySource: VolumeRow[];
  byCompany: VolumeRow[];
}

export interface SlaRow {
  key: string | null;
  label: string;
  tickets: number;
  firstResponse: { met: number; breached: number; pending: number; compliance: number | null };
  resolution: { met: number; breached: number; pending: number; compliance: number | null };
}

export interface BreachedTicket {
  id: string;
  reference: string;
  subject: string;
  priority: string;
  company: string | null;
  assignee: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  createdAt: string;
}

export interface SlaReport {
  range: RangeInfo;
  overall: SlaRow;
  byPriority: SlaRow[];
  byCategory: SlaRow[];
  byCompany: SlaRow[];
  breached: BreachedTicket[];
  breachedTotal: number;
}

export interface TimingStats {
  count: number;
  medianHours: number | null;
  p90Hours: number | null;
}

export interface ResponseTimeRow {
  key: string | null;
  label: string;
  tickets: number;
  firstResponse: TimingStats;
  resolution: TimingStats;
}

export interface ResponseTimesReport {
  range: RangeInfo;
  overall: ResponseTimeRow;
  byPriority: ResponseTimeRow[];
  byAssignee: ResponseTimeRow[];
}

export interface CsatRow {
  key: string | null;
  label: string;
  closed: number;
  rated: number;
  average: number | null;
  responseRate: number | null;
}

export interface CsatReport {
  range: RangeInfo;
  overall: CsatRow;
  distribution: { rating: number; count: number }[];
  byAssignee: CsatRow[];
  byCompany: CsatRow[];
  comments: { reference: string; rating: number; comment: string; company: string | null; ratedAt: string | null }[];
}

// ─── SQL pieces ───

const DONE = Prisma.sql`COALESCE(t."resolvedAt", t."closedAt")`;
const BREACHED_LIST_LIMIT = 500;
const EXPORT_LIST_LIMIT = 10000;
const GROUP_LIMIT = 100;

interface Dim {
  key: Prisma.Sql;
  label: Prisma.Sql;
  joins: Prisma.Sql;
}

type Row = Record<string, unknown>;

const NO_KEY = Prisma.sql`NULL::text`;

function priorityLabel(p: string | null): string {
  return (p && TICKET_PRIORITY_LABELS[p as TicketPriority]) || p || "None";
}

const PRIORITY_ORDER = new Map<string, number>(TICKET_PRIORITIES.map((p, i) => [p, -i]));

function sortByPriority<T extends { key: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (PRIORITY_ORDER.get(a.key ?? "") ?? 1) - (PRIORITY_ORDER.get(b.key ?? "") ?? 1));
}

@Injectable()
export class TicketReportsService {
  constructor(private prisma: PrismaService) {}

  /** Tickets of the workspace counted in reports: merged duplicates are left out. */
  private base(ctx: ReportContext, alias = "t"): Prisma.Sql {
    const t = Prisma.raw(`"${alias}"`);
    return Prisma.sql`${t}."organizationId" = ${ctx.orgId} AND ${t}."mergedIntoId" IS NULL ${companyFilter(
      ctx,
      Prisma.sql`${t}."companyId"`,
    )}`;
  }

  private dims(alias: string): Record<"category" | "priority" | "source" | "company" | "assignee", Dim> {
    const t = Prisma.raw(`"${alias}"`);
    return {
      category: {
        key: Prisma.sql`${t}."categoryId"`,
        label: Prisma.sql`COALESCE(cat.name, 'Uncategorized')`,
        joins: Prisma.sql`LEFT JOIN "ticket_category" cat ON cat.id = ${t}."categoryId"`,
      },
      priority: { key: Prisma.sql`${t}.priority`, label: Prisma.sql`${t}.priority`, joins: Prisma.empty },
      source: { key: Prisma.sql`${t}.source`, label: Prisma.sql`${t}.source`, joins: Prisma.empty },
      company: {
        key: Prisma.sql`${t}."companyId"`,
        label: Prisma.sql`COALESCE(co.name, 'No company')`,
        joins: Prisma.sql`LEFT JOIN "company" co ON co.id = ${t}."companyId"`,
      },
      assignee: {
        key: Prisma.sql`${t}."assigneeId"`,
        label: Prisma.sql`COALESCE(u.name, 'Unassigned')`,
        joins: Prisma.sql`LEFT JOIN "user" u ON u.id = ${t}."assigneeId"`,
      },
    };
  }

  private async ticketPrefix(orgId: string): Promise<string> {
    const s = await this.prisma.serviceSettings.findUnique({
      where: { organizationId: orgId },
      select: { ticketPrefix: true },
    });
    return s?.ticketPrefix ?? "TKT";
  }

  // ─── Ticket volume ───

  async volume(ctx: ReportContext): Promise<TicketVolumeReport> {
    const { start, end } = ctx.range;
    const tz = ctx.range.timezone;
    const created = Prisma.sql`t."createdAt"`;
    const keys: string[] = ctx.buckets.map((b) => b.key);
    // Backlog is measured at each bucket's end, but never past the range or now.
    const cap = Math.min(end.getTime(), ctx.now.getTime());
    const ends: string[] = ctx.buckets.map((b) =>
      new Date(Math.min(zonedDayStart(b.endKey, tz).getTime(), cap)).toISOString(),
    );

    const seriesQ = this.prisma.$queryRaw<Row[]>`
      SELECT k, SUM(c)::int AS created, SUM(r)::int AS resolved FROM (
        SELECT ${bucketKeySql(created, ctx.unit, tz)} AS k, 1 AS c, 0 AS r
        FROM "ticket" t WHERE ${this.base(ctx)} AND ${inRange(created, start, end)}
        UNION ALL
        SELECT ${bucketKeySql(DONE, ctx.unit, tz)} AS k, 0 AS c, 1 AS r
        FROM "ticket" t WHERE ${this.base(ctx)} AND ${inRange(DONE, start, end)}
      ) x GROUP BY k
    `;
    const backlogQ = this.prisma.$queryRaw<Row[]>`
      SELECT b.k, (
        SELECT count(*) FROM "ticket" t
        WHERE ${this.base(ctx)} AND t."createdAt" < b.e AND (${DONE} IS NULL OR ${DONE} >= b.e)
      )::int AS open
      FROM unnest(${keys}::text[], ${ends}::timestamp[]) AS b(k, e)
    `;
    const d = this.dims("t");
    const [seriesRows, backlogRows, byCategory, byPriority, bySource, byCompany] = await Promise.all([
      seriesQ,
      backlogQ,
      this.volumeBy(ctx, d.category),
      this.volumeBy(ctx, d.priority),
      this.volumeBy(ctx, d.source),
      this.volumeBy(ctx, d.company),
    ]);

    const counts = new Map(seriesRows.map((r) => [String(r.k), r]));
    const backlog = new Map(backlogRows.map((r) => [String(r.k), num(r.open)]));
    const series = ctx.buckets.map((b) => ({
      bucket: b.key,
      created: num(counts.get(b.key)?.created),
      resolved: num(counts.get(b.key)?.resolved),
      backlog: backlog.get(b.key) ?? 0,
    }));
    return {
      range: rangeInfo(ctx),
      totals: {
        created: series.reduce((s, r) => s + r.created, 0),
        resolved: series.reduce((s, r) => s + r.resolved, 0),
        backlog: series.length ? series[series.length - 1].backlog : 0,
      },
      series,
      byCategory,
      byPriority: sortByPriority(byPriority).map((r) => ({ ...r, label: priorityLabel(r.key) })),
      bySource,
      byCompany,
    };
  }

  private async volumeBy(ctx: ReportContext, dim: Dim): Promise<VolumeRow[]> {
    const { start, end } = ctx.range;
    const created = Prisma.sql`t."createdAt"`;
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT ${dim.key} AS key, ${dim.label} AS label,
        count(*) FILTER (WHERE ${inRange(created, start, end)})::int AS created,
        count(*) FILTER (WHERE ${inRange(DONE, start, end)})::int AS resolved
      FROM "ticket" t ${dim.joins}
      WHERE ${this.base(ctx)} AND (${inRange(created, start, end)} OR ${inRange(DONE, start, end)})
      GROUP BY 1, 2
      ORDER BY 3 DESC, 4 DESC, 2 ASC
      LIMIT ${GROUP_LIMIT}
    `;
    return rows.map((r) => ({
      key: (r.key as string | null) ?? null,
      label: String(r.label),
      created: num(r.created),
      resolved: num(r.resolved),
    }));
  }

  // ─── SLA compliance ───

  /**
   * Tickets created in the range with their SLA outcome. A target is breached
   * when the helpdesk flagged it, or when the ticket is still open (and not
   * paused) past the due time. Met: answered (or closed) / resolved without a
   * breach. Pending: still inside its target. Compliance = met / (met + breached).
   */
  private slaCte(ctx: ReportContext): Prisma.Sql {
    const now = ts(ctx.now);
    const open = Prisma.sql`${DONE} IS NULL AND t."slaPausedAt" IS NULL`;
    return Prisma.sql`WITH s AS (
      SELECT t.id, t.number, t.subject, t.priority, t."categoryId", t."companyId", t."assigneeId", t."createdAt",
        CASE
          WHEN t."firstResponseDueAt" IS NULL AND NOT t."firstResponseBreached" THEN NULL
          WHEN t."firstResponseBreached"
            OR (t."firstRespondedAt" IS NULL AND ${open} AND t."firstResponseDueAt" < ${now}) THEN 'breached'
          WHEN t."firstRespondedAt" IS NOT NULL OR ${DONE} IS NOT NULL THEN 'met'
          ELSE 'pending'
        END AS fr,
        CASE
          WHEN t."resolutionDueAt" IS NULL AND NOT t."resolutionBreached" THEN NULL
          WHEN t."resolutionBreached" OR (${open} AND t."resolutionDueAt" < ${now}) THEN 'breached'
          WHEN ${DONE} IS NOT NULL THEN 'met'
          ELSE 'pending'
        END AS res
      FROM "ticket" t
      WHERE ${this.base(ctx)} AND ${inRange(Prisma.sql`t."createdAt"`, ctx.range.start, ctx.range.end)}
    )`;
  }

  private async slaBy(ctx: ReportContext, dim: Dim | null): Promise<SlaRow[]> {
    const key = dim ? dim.key : NO_KEY;
    const label = dim ? dim.label : Prisma.sql`'All tickets'`;
    const group = dim ? Prisma.sql`GROUP BY 1, 2 ORDER BY 3 DESC, 2 ASC LIMIT ${GROUP_LIMIT}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Row[]>`
      ${this.slaCte(ctx)}
      SELECT ${key} AS key, ${label} AS label,
        count(*)::int AS tickets,
        count(*) FILTER (WHERE s.fr = 'met')::int AS fr_met,
        count(*) FILTER (WHERE s.fr = 'breached')::int AS fr_breached,
        count(*) FILTER (WHERE s.fr = 'pending')::int AS fr_pending,
        count(*) FILTER (WHERE s.res = 'met')::int AS res_met,
        count(*) FILTER (WHERE s.res = 'breached')::int AS res_breached,
        count(*) FILTER (WHERE s.res = 'pending')::int AS res_pending
      FROM s ${dim ? dim.joins : Prisma.empty}
      ${group}
    `;
    return rows.map((r) => {
      const frMet = num(r.fr_met);
      const frBreached = num(r.fr_breached);
      const resMet = num(r.res_met);
      const resBreached = num(r.res_breached);
      return {
        key: (r.key as string | null) ?? null,
        label: String(r.label),
        tickets: num(r.tickets),
        firstResponse: {
          met: frMet,
          breached: frBreached,
          pending: num(r.fr_pending),
          compliance: percent(frMet, frMet + frBreached),
        },
        resolution: {
          met: resMet,
          breached: resBreached,
          pending: num(r.res_pending),
          compliance: percent(resMet, resMet + resBreached),
        },
      };
    });
  }

  async breachedTickets(ctx: ReportContext, limit: number = BREACHED_LIST_LIMIT): Promise<{ rows: BreachedTicket[]; total: number }> {
    const [prefix, rows, totalRows] = await Promise.all([
      this.ticketPrefix(ctx.orgId),
      this.prisma.$queryRaw<Row[]>`
        ${this.slaCte(ctx)}
        SELECT s.id, s.number, s.subject, s.priority, s."createdAt", s.fr, s.res,
          co.name AS company, u.name AS assignee
        FROM s
        LEFT JOIN "company" co ON co.id = s."companyId"
        LEFT JOIN "user" u ON u.id = s."assigneeId"
        WHERE s.fr = 'breached' OR s.res = 'breached'
        ORDER BY s."createdAt" DESC, s.number DESC
        LIMIT ${Math.min(limit, EXPORT_LIST_LIMIT)}
      `,
      this.prisma.$queryRaw<Row[]>`
        ${this.slaCte(ctx)}
        SELECT count(*)::int AS n FROM s WHERE s.fr = 'breached' OR s.res = 'breached'
      `,
    ]);
    return {
      total: num(totalRows[0]?.n),
      rows: rows.map((r) => ({
        id: String(r.id),
        reference: formatReference(prefix, num(r.number)),
        subject: String(r.subject),
        priority: String(r.priority),
        company: (r.company as string | null) ?? null,
        assignee: (r.assignee as string | null) ?? null,
        firstResponseBreached: r.fr === "breached",
        resolutionBreached: r.res === "breached",
        createdAt: (r.createdAt as Date).toISOString(),
      })),
    };
  }

  async sla(ctx: ReportContext): Promise<SlaReport> {
    const d = this.dims("s");
    const [overall, byPriority, byCategory, byCompany, breached] = await Promise.all([
      this.slaBy(ctx, null),
      this.slaBy(ctx, d.priority),
      this.slaBy(ctx, d.category),
      this.slaBy(ctx, d.company),
      this.breachedTickets(ctx),
    ]);
    return {
      range: rangeInfo(ctx),
      overall: overall[0],
      byPriority: sortByPriority(byPriority).map((r) => ({ ...r, label: priorityLabel(r.key) })),
      byCategory,
      byCompany,
      breached: breached.rows,
      breachedTotal: breached.total,
    };
  }

  // ─── Response and resolution times ───

  private async timesBy(ctx: ReportContext, dim: Dim | null): Promise<ResponseTimeRow[]> {
    const key = dim ? dim.key : NO_KEY;
    const label = dim ? dim.label : Prisma.sql`'All tickets'`;
    const group = dim ? Prisma.sql`GROUP BY 1, 2 ORDER BY 3 DESC, 2 ASC LIMIT ${GROUP_LIMIT}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Row[]>`
      WITH r AS (
        SELECT t.priority, t."assigneeId",
          -- GREATEST skips NULLs, so guard it to keep unanswered tickets out of the percentiles.
          CASE WHEN t."firstRespondedAt" IS NOT NULL
            THEN GREATEST(EXTRACT(EPOCH FROM (t."firstRespondedAt" - t."createdAt")), 0) / 3600.0 END AS fr,
          CASE WHEN t."resolvedAt" IS NOT NULL
            THEN GREATEST(EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")), 0) / 3600.0 END AS res
        FROM "ticket" t
        WHERE ${this.base(ctx)} AND ${inRange(Prisma.sql`t."createdAt"`, ctx.range.start, ctx.range.end)}
      )
      SELECT ${key} AS key, ${label} AS label,
        count(*)::int AS tickets,
        count(r.fr)::int AS fr_n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY r.fr) AS fr_p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY r.fr) AS fr_p90,
        count(r.res)::int AS res_n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY r.res) AS res_p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY r.res) AS res_p90
      FROM r ${dim ? dim.joins : Prisma.empty}
      ${group}
    `;
    return rows.map((r) => ({
      key: (r.key as string | null) ?? null,
      label: String(r.label),
      tickets: num(r.tickets),
      firstResponse: { count: num(r.fr_n), medianHours: hours(r.fr_p50), p90Hours: hours(r.fr_p90) },
      resolution: { count: num(r.res_n), medianHours: hours(r.res_p50), p90Hours: hours(r.res_p90) },
    }));
  }

  async responseTimes(ctx: ReportContext): Promise<ResponseTimesReport> {
    const d = this.dims("r");
    const [overall, byPriority, byAssignee] = await Promise.all([
      this.timesBy(ctx, null),
      this.timesBy(ctx, d.priority),
      this.timesBy(ctx, d.assignee),
    ]);
    return {
      range: rangeInfo(ctx),
      overall: overall[0],
      byPriority: sortByPriority(byPriority).map((r) => ({ ...r, label: priorityLabel(r.key) })),
      byAssignee,
    };
  }

  // ─── CSAT ───

  /** Tickets resolved or closed in the range; ratings outside 1-5 are ignored. */
  private csatCte(ctx: ReportContext): Prisma.Sql {
    return Prisma.sql`WITH c AS (
      SELECT t.id, t.number, t."companyId", t."assigneeId", t."csatComment" AS comment, t."csatAt",
        CASE WHEN t."csatRating" BETWEEN 1 AND 5 THEN t."csatRating" END AS rating
      FROM "ticket" t
      WHERE ${this.base(ctx)} AND ${inRange(DONE, ctx.range.start, ctx.range.end)}
    )`;
  }

  private async csatBy(ctx: ReportContext, dim: Dim | null): Promise<CsatRow[]> {
    const key = dim ? dim.key : NO_KEY;
    const label = dim ? dim.label : Prisma.sql`'All tickets'`;
    const group = dim ? Prisma.sql`GROUP BY 1, 2 ORDER BY 4 DESC, 3 DESC, 2 ASC LIMIT ${GROUP_LIMIT}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Row[]>`
      ${this.csatCte(ctx)}
      SELECT ${key} AS key, ${label} AS label,
        count(*)::int AS closed, count(c.rating)::int AS rated, avg(c.rating)::float AS average
      FROM c ${dim ? dim.joins : Prisma.empty}
      ${group}
    `;
    return rows.map((r) => {
      const avg = numOrNull(r.average);
      return {
        key: (r.key as string | null) ?? null,
        label: String(r.label),
        closed: num(r.closed),
        rated: num(r.rated),
        average: avg === null ? null : Math.round(avg * 100) / 100,
        responseRate: percent(num(r.rated), num(r.closed)),
      };
    });
  }

  async csat(ctx: ReportContext): Promise<CsatReport> {
    const d = this.dims("c");
    const [prefix, overall, dist, byAssignee, byCompany, comments] = await Promise.all([
      this.ticketPrefix(ctx.orgId),
      this.csatBy(ctx, null),
      this.prisma.$queryRaw<Row[]>`
        ${this.csatCte(ctx)}
        SELECT c.rating, count(*)::int AS n FROM c WHERE c.rating IS NOT NULL GROUP BY 1
      `,
      this.csatBy(ctx, d.assignee),
      this.csatBy(ctx, d.company),
      this.prisma.$queryRaw<Row[]>`
        ${this.csatCte(ctx)}
        SELECT c.number, c.rating, c.comment, c."csatAt", co.name AS company
        FROM c LEFT JOIN "company" co ON co.id = c."companyId"
        WHERE c.rating IS NOT NULL AND c.comment IS NOT NULL AND btrim(c.comment) <> ''
        ORDER BY c."csatAt" DESC NULLS LAST, c.number DESC
        LIMIT 25
      `,
    ]);
    const byRating = new Map(dist.map((r) => [num(r.rating), num(r.n)]));
    return {
      range: rangeInfo(ctx),
      overall: overall[0],
      distribution: [1, 2, 3, 4, 5].map((rating) => ({ rating, count: byRating.get(rating) ?? 0 })),
      byAssignee,
      byCompany,
      comments: comments.map((r) => ({
        reference: formatReference(prefix, num(r.number)),
        rating: num(r.rating),
        comment: String(r.comment),
        company: (r.company as string | null) ?? null,
        ratedAt: r.csatAt ? (r.csatAt as Date).toISOString() : null,
      })),
    };
  }
}

