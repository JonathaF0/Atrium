import { Injectable } from "@nestjs/common";
import { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { companyFilter, rangeInfo } from "./report-context.service";
import type { RangeInfo, ReportContext } from "./report-context.service";
import { inRange, num, projectCompanyLateral } from "./report-sql";
import { contractAllowanceMinutes } from "./report-math";

export interface ContractUsage {
  id: string;
  name: string;
  coveragePeriod: string;
  allowanceSec: number;
  usedSec: number;
  overageSec: number;
}

export interface HoursRow {
  companyId: string | null;
  companyName: string;
  totalSec: number;
  billableSec: number;
  nonBillableSec: number;
  uninvoicedBillableSec: number;
  ticketSec: number;
  projectSec: number;
  contractSec: number;
  allowanceSec: number;
  overageSec: number;
  contracts: ContractUsage[];
}

export interface HoursReport {
  range: RangeInfo;
  totals: Omit<HoursRow, "companyId" | "companyName" | "contracts">;
  companies: HoursRow[];
}

type Row = Record<string, unknown>;

/** Contract statuses whose allowance counts for the time they ran. */
const ALLOWANCE_STATUSES = ["active", "expired"];

@Injectable()
export class HoursReportService {
  constructor(private prisma: PrismaService) {}

  /**
   * Finished time entries started in the range, each with the company it is for:
   * the contract's company, else the ticket's, else the project's client company.
   */
  private entriesCte(ctx: ReportContext): Prisma.Sql {
    return Prisma.sql`WITH te AS (
      SELECT e."durationSec" AS s, e.billable, e."invoiceLineItemId", e."ticketId", e."contractId",
        COALESCE(ct."companyId", tk."companyId", pco."companyId") AS "companyId"
      FROM "time_entry" e
      LEFT JOIN "contract" ct ON ct.id = e."contractId" AND ct."organizationId" = ${ctx.orgId}
      LEFT JOIN "ticket" tk ON tk.id = e."ticketId" AND tk."organizationId" = ${ctx.orgId}
      ${projectCompanyLateral(Prisma.sql`e."projectId"`, ctx.orgId)} pco ON TRUE
      WHERE e."organizationId" = ${ctx.orgId} AND e."durationSec" IS NOT NULL
        AND ${inRange(Prisma.sql`e."startedAt"`, ctx.range.start, ctx.range.end)}
    ), f AS (
      SELECT * FROM te WHERE TRUE ${companyFilter(ctx, Prisma.sql`te."companyId"`)}
    )`;
  }

  async hours(ctx: ReportContext): Promise<HoursReport> {
    const cte = this.entriesCte(ctx);
    const [byCompany, byContract, contracts] = await Promise.all([
      this.prisma.$queryRaw<Row[]>`
        ${cte}
        SELECT f."companyId", co.name AS "companyName",
          COALESCE(SUM(f.s), 0)::bigint AS total,
          COALESCE(SUM(f.s) FILTER (WHERE f.billable), 0)::bigint AS billable,
          COALESCE(SUM(f.s) FILTER (WHERE NOT f.billable), 0)::bigint AS non_billable,
          COALESCE(SUM(f.s) FILTER (WHERE f.billable AND f."invoiceLineItemId" IS NULL), 0)::bigint AS uninvoiced,
          COALESCE(SUM(f.s) FILTER (WHERE f."ticketId" IS NOT NULL), 0)::bigint AS ticket,
          COALESCE(SUM(f.s) FILTER (WHERE f."contractId" IS NOT NULL), 0)::bigint AS contract
        FROM f LEFT JOIN "company" co ON co.id = f."companyId"
        GROUP BY 1, 2
      `,
      this.prisma.$queryRaw<Row[]>`
        ${cte}
        SELECT f."contractId", SUM(f.s)::bigint AS used
        FROM f WHERE f."contractId" IS NOT NULL
        GROUP BY 1
      `,
      this.prisma.contract.findMany({
        where: {
          organizationId: ctx.orgId,
          status: { in: ALLOWANCE_STATUSES },
          coveredMinutes: { gt: 0 },
          startsAt: { lt: ctx.range.end },
          OR: [{ endsAt: null }, { endsAt: { gt: ctx.range.start } }],
          ...(ctx.companyId ? { companyId: ctx.companyId } : {}),
        },
        select: {
          id: true,
          name: true,
          companyId: true,
          startsAt: true,
          endsAt: true,
          coveredMinutes: true,
          coveragePeriod: true,
          company: { select: { name: true } },
        },
        orderBy: { startsAt: "asc" },
      }),
    ]);

    const usedByContract = new Map(byContract.map((r) => [String(r.contractId), num(r.used)]));
    const rows = new Map<string, HoursRow>();
    const keyOf = (id: string | null): string => id ?? "";
    const blank = (companyId: string | null, companyName: string): HoursRow => ({
      companyId,
      companyName,
      totalSec: 0,
      billableSec: 0,
      nonBillableSec: 0,
      uninvoicedBillableSec: 0,
      ticketSec: 0,
      projectSec: 0,
      contractSec: 0,
      allowanceSec: 0,
      overageSec: 0,
      contracts: [],
    });

    for (const r of byCompany) {
      const companyId = (r.companyId as string | null) ?? null;
      const row = blank(companyId, (r.companyName as string | null) ?? "No company");
      row.totalSec = num(r.total);
      row.billableSec = num(r.billable);
      row.nonBillableSec = num(r.non_billable);
      row.uninvoicedBillableSec = num(r.uninvoiced);
      row.ticketSec = num(r.ticket);
      row.projectSec = row.totalSec - row.ticketSec;
      row.contractSec = num(r.contract);
      rows.set(keyOf(companyId), row);
    }

    for (const c of contracts) {
      const row = rows.get(c.companyId) ?? blank(c.companyId, c.company.name);
      rows.set(c.companyId, row);
      const allowanceSec = contractAllowanceMinutes(c, ctx.range.start, ctx.range.end) * 60;
      const usedSec = usedByContract.get(c.id) ?? 0;
      row.contracts.push({
        id: c.id,
        name: c.name,
        coveragePeriod: c.coveragePeriod,
        allowanceSec,
        usedSec,
        overageSec: Math.max(0, usedSec - allowanceSec),
      });
      row.allowanceSec += allowanceSec;
    }
    // Time logged against contracts without an allowance in the range is all overage.
    for (const row of rows.values()) {
      const covered = row.contracts.reduce((s, c) => s + c.usedSec, 0);
      row.overageSec = row.contracts.reduce((s, c) => s + c.overageSec, 0) + Math.max(0, row.contractSec - covered);
    }

    const companies = [...rows.values()].sort(
      (a, b) => b.totalSec - a.totalSec || b.allowanceSec - a.allowanceSec || a.companyName.localeCompare(b.companyName),
    );
    const totals = companies.reduce(
      (t, r) => ({
        totalSec: t.totalSec + r.totalSec,
        billableSec: t.billableSec + r.billableSec,
        nonBillableSec: t.nonBillableSec + r.nonBillableSec,
        uninvoicedBillableSec: t.uninvoicedBillableSec + r.uninvoicedBillableSec,
        ticketSec: t.ticketSec + r.ticketSec,
        projectSec: t.projectSec + r.projectSec,
        contractSec: t.contractSec + r.contractSec,
        allowanceSec: t.allowanceSec + r.allowanceSec,
        overageSec: t.overageSec + r.overageSec,
      }),
      {
        totalSec: 0,
        billableSec: 0,
        nonBillableSec: 0,
        uninvoicedBillableSec: 0,
        ticketSec: 0,
        projectSec: 0,
        contractSec: 0,
        allowanceSec: 0,
        overageSec: 0,
      },
    );
    return { range: rangeInfo(ctx), totals, companies };
  }
}
