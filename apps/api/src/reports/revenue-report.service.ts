import { Injectable } from "@nestjs/common";
import { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { companyFilter, rangeInfo } from "./report-context.service";
import type { RangeInfo, ReportContext } from "./report-context.service";
import { buildBuckets, localDateKey } from "./report-range";
import { bucketKeySql, inRange, localTime, num, projectCompanyLateral } from "./report-sql";
import { AGING_BUCKETS, agingBucketSql, invoiceTotalSql, monthlyRecurringCents, percent } from "./report-math";
import type { AgingKey } from "./report-math";

export type AgingAmounts = Record<AgingKey, number>;

export interface AgingRow {
  companyId: string | null;
  companyName: string;
  invoices: number;
  totalCents: number;
  buckets: AgingAmounts;
}

export interface RevenueReport {
  range: RangeInfo;
  totals: {
    invoicedCents: number;
    collectedCents: number;
    outstandingCents: number;
    overdueCents: number;
  };
  monthly: { month: string; invoicedCents: number; collectedCents: number; outstandingCents: number }[];
  aging: { totals: AgingAmounts; companies: AgingRow[] };
  recurring: {
    mrrCents: number;
    arrCents: number;
    schedules: number;
    companies: { companyId: string | null; companyName: string; mrrCents: number }[];
  };
  estimates: {
    openCount: number;
    openCents: number;
    openRecurringCents: number;
    sentInRange: number;
    accepted: number;
    declined: number;
    expired: number;
    acceptanceRate: number | null;
  };
}

type Row = Record<string, unknown>;

const OPEN = Prisma.sql`('sent', 'overdue')`;

function emptyAging(): AgingAmounts {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])) as AgingAmounts;
}

@Injectable()
export class RevenueReportService {
  constructor(private prisma: PrismaService) {}

  /**
   * Issued invoices (not draft or cancelled) relevant to the report, with their
   * total and company: the schedule's or estimate's company, else the project's
   * client company. Open invoices are always included for aging.
   */
  private invoicesCte(ctx: ReportContext): Prisma.Sql {
    const { start, end } = ctx.range;
    return Prisma.sql`WITH inv AS MATERIALIZED (
      SELECT i.id, i.status, i."createdAt", i."dueDate", i."paidAt", i."paidAmount",
        ${invoiceTotalSql("i")} AS total,
        COALESCE(ri."companyId", es."companyId", pco."companyId") AS "companyId"
      FROM "invoice" i
      LEFT JOIN "recurring_invoice" ri ON ri.id = i."recurringInvoiceId" AND ri."organizationId" = ${ctx.orgId}
      LEFT JOIN "estimate" es ON es.id = i."estimateId" AND es."organizationId" = ${ctx.orgId}
      ${projectCompanyLateral(Prisma.sql`i."projectId"`, ctx.orgId)} pco ON TRUE
      WHERE i."organizationId" = ${ctx.orgId} AND i.status NOT IN ('draft', 'cancelled')
        AND (${inRange(Prisma.sql`i."createdAt"`, start, end)} OR ${inRange(Prisma.sql`i."paidAt"`, start, end)}
          OR i.status IN ${OPEN})
    ), f AS (
      SELECT * FROM inv WHERE TRUE ${companyFilter(ctx, Prisma.sql`inv."companyId"`)}
    )`;
  }

  async revenue(ctx: ReportContext): Promise<RevenueReport> {
    const { start, end, timezone: tz } = ctx.range;
    const cte = this.invoicesCte(ctx);
    const today = localDateKey(ctx.now, tz);
    const daysPastDue = Prisma.sql`(${today}::date - (${localTime(Prisma.sql`f."dueDate"`, tz)})::date)`;
    const months = buildBuckets(ctx.range.from, ctx.range.to, "month");

    const [monthlyRows, openRows, agingRows, mrrRows, pipelineRows, acceptanceRows] = await Promise.all([
      this.prisma.$queryRaw<Row[]>`
        ${cte}
        SELECT k, SUM(inv)::bigint AS invoiced, SUM(col)::bigint AS collected, SUM(outst)::bigint AS outstanding FROM (
          SELECT ${bucketKeySql(Prisma.sql`f."createdAt"`, "month", tz)} AS k, f.total AS inv, 0 AS col,
            CASE WHEN f.status IN ${OPEN} THEN f.total ELSE 0 END AS outst
          FROM f WHERE ${inRange(Prisma.sql`f."createdAt"`, start, end)}
          UNION ALL
          SELECT ${bucketKeySql(Prisma.sql`f."paidAt"`, "month", tz)}, 0, COALESCE(f."paidAmount", f.total), 0
          FROM f WHERE f.status = 'paid' AND ${inRange(Prisma.sql`f."paidAt"`, start, end)}
        ) x GROUP BY k
      `,
      this.prisma.$queryRaw<Row[]>`
        ${cte}
        SELECT COALESCE(SUM(f.total), 0)::bigint AS outstanding,
          COALESCE(SUM(f.total) FILTER (WHERE ${daysPastDue} > 0), 0)::bigint AS overdue
        FROM f WHERE f.status IN ${OPEN}
      `,
      this.prisma.$queryRaw<Row[]>`
        ${cte}
        SELECT f."companyId", co.name AS "companyName", ${agingBucketSql(daysPastDue)} AS bucket,
          SUM(f.total)::bigint AS amount, count(*)::int AS n
        FROM f LEFT JOIN "company" co ON co.id = f."companyId"
        WHERE f.status IN ${OPEN}
        GROUP BY 1, 2, 3
      `,
      this.prisma.$queryRaw<Row[]>`
        SELECT ri.interval, ri."intervalCount", ri."companyId", co.name AS "companyName",
          count(*)::int AS schedules,
          COALESCE(SUM((
            SELECT SUM(it.quantity::bigint * it."unitPrice") FROM "recurring_invoice_item" it
            WHERE it."recurringInvoiceId" = ri.id
          )), 0)::bigint AS run
        FROM "recurring_invoice" ri LEFT JOIN "company" co ON co.id = ri."companyId"
        WHERE ri."organizationId" = ${ctx.orgId} AND ri.status = 'active'
          AND (ri."endDate" IS NULL OR ri."endDate" > ${ctx.now.toISOString()}::timestamp)
          ${companyFilter(ctx, Prisma.sql`ri."companyId"`)}
        GROUP BY 1, 2, 3, 4
      `,
      this.prisma.$queryRaw<Row[]>(this.pipelineSql(ctx)),
      this.prisma.$queryRaw<Row[]>`
        SELECT count(*)::int AS sent,
          count(*) FILTER (WHERE e.status IN ('accepted', 'converted'))::int AS accepted,
          count(*) FILTER (WHERE e.status = 'declined')::int AS declined,
          count(*) FILTER (WHERE e.status = 'expired')::int AS expired
        FROM "estimate" e
        WHERE e."organizationId" = ${ctx.orgId} AND e.status <> 'superseded'
          AND ${inRange(Prisma.sql`e."sentAt"`, start, end)}
          ${companyFilter(ctx, Prisma.sql`e."companyId"`)}
      `,
    ]);

    const byMonth = new Map(monthlyRows.map((r) => [String(r.k), r]));
    const monthly = months.map((m) => ({
      month: m.key.slice(0, 7),
      invoicedCents: num(byMonth.get(m.key)?.invoiced),
      collectedCents: num(byMonth.get(m.key)?.collected),
      outstandingCents: num(byMonth.get(m.key)?.outstanding),
    }));

    const agingTotals = emptyAging();
    const agingByCompany = new Map<string, AgingRow>();
    for (const r of agingRows) {
      const companyId = (r.companyId as string | null) ?? null;
      const key = companyId ?? "";
      const row = agingByCompany.get(key) ?? {
        companyId,
        companyName: (r.companyName as string | null) ?? "No company",
        invoices: 0,
        totalCents: 0,
        buckets: emptyAging(),
      };
      const bucket = String(r.bucket) as AgingKey;
      const amount = num(r.amount);
      row.buckets[bucket] += amount;
      row.totalCents += amount;
      row.invoices += num(r.n);
      agingTotals[bucket] += amount;
      agingByCompany.set(key, row);
    }

    let mrrCents = 0;
    let schedules = 0;
    const mrrByCompany = new Map<string, { companyId: string | null; companyName: string; mrrCents: number }>();
    for (const r of mrrRows) {
      const mrr = monthlyRecurringCents(num(r.run), String(r.interval), num(r.intervalCount));
      mrrCents += mrr;
      schedules += num(r.schedules);
      const companyId = (r.companyId as string | null) ?? null;
      const entry = mrrByCompany.get(companyId ?? "") ?? {
        companyId,
        companyName: (r.companyName as string | null) ?? "No company",
        mrrCents: 0,
      };
      entry.mrrCents += mrr;
      mrrByCompany.set(companyId ?? "", entry);
    }

    const pipeline = pipelineRows[0] ?? {};
    const acc = acceptanceRows[0] ?? {};
    const open = openRows[0] ?? {};
    return {
      range: rangeInfo(ctx),
      totals: {
        invoicedCents: monthly.reduce((s, m) => s + m.invoicedCents, 0),
        collectedCents: monthly.reduce((s, m) => s + m.collectedCents, 0),
        outstandingCents: num(open.outstanding),
        overdueCents: num(open.overdue),
      },
      monthly,
      aging: {
        totals: agingTotals,
        companies: [...agingByCompany.values()].sort((a, b) => b.totalCents - a.totalCents),
      },
      recurring: {
        mrrCents,
        arrCents: mrrCents * 12,
        schedules,
        companies: [...mrrByCompany.values()].sort((a, b) => b.mrrCents - a.mrrCents),
      },
      estimates: {
        openCount: num(pipeline.n),
        openCents: num(pipeline.total),
        openRecurringCents: num(pipeline.recurring),
        sentInRange: num(acc.sent),
        accepted: num(acc.accepted),
        declined: num(acc.declined),
        expired: num(acc.expired),
        acceptanceRate: percent(num(acc.accepted), num(acc.sent)),
      },
    };
  }

  /**
   * Sent and viewed estimates and their totals, by the same rule as
   * `computeEstimateTotals`: optional lines only when selected, the discount on
   * one-time lines spread before tax, recurring lines totalled separately.
   */
  private pipelineSql(ctx: ReportContext): Prisma.Sql {
    return Prisma.sql`
      WITH el AS (
        SELECT e.id, e."discountType" AS dt, e."discountValue" AS dv,
          li."billingType" AS bt, li.taxable, li."taxRateBps" AS bps,
          ROUND(li.quantity * li."unitPriceCents") AS lt
        FROM "estimate" e
        LEFT JOIN "estimate_line_item" li ON li."estimateId" = e.id AND (NOT li.optional OR li.selected)
        WHERE e."organizationId" = ${ctx.orgId} AND e.status IN ('sent', 'viewed')
          ${companyFilter(ctx, Prisma.sql`e."companyId"`)}
      ), sub AS (
        SELECT id, dt, dv,
          COALESCE(SUM(lt) FILTER (WHERE bt <> 'recurring'), 0) AS one,
          COALESCE(SUM(lt) FILTER (WHERE bt = 'recurring'), 0) AS rec
        FROM el GROUP BY id, dt, dv
      ), d AS (
        SELECT id, one, rec,
          CASE
            WHEN dt = 'percent' AND dv IS NOT NULL THEN ROUND(one * LEAST(dv, 10000) / 10000.0)
            WHEN dt = 'amount' AND dv IS NOT NULL THEN LEAST(dv, one)
            ELSE 0
          END AS disc
        FROM sub
      ), tx AS (
        SELECT el.id, COALESCE(SUM(
          ROUND(el.lt * (CASE WHEN d.one > 0 THEN 1 - d.disc / d.one ELSE 1 END) * el.bps / 10000.0)
        ) FILTER (WHERE el.taxable AND el.bps > 0 AND el.bt <> 'recurring'), 0) AS tax
        FROM el JOIN d ON d.id = el.id GROUP BY el.id
      )
      SELECT count(*)::int AS n, COALESCE(SUM(d.one - d.disc + tx.tax), 0)::bigint AS total,
        COALESCE(SUM(d.rec), 0)::bigint AS recurring
      FROM d JOIN tx ON tx.id = d.id
    `;
  }
}
