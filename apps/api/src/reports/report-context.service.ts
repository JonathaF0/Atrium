import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import type { ReportQueryDto } from "./reports.dto";
import { buildBuckets, chooseBucket, resolveRange } from "./report-range";
import type { Bucket, BucketUnit, ReportRange } from "./report-range";

export interface ReportContext {
  orgId: string;
  range: ReportRange;
  unit: BucketUnit;
  buckets: Bucket[];
  companyId: string | null;
  now: Date;
}

export interface RangeInfo {
  from: string;
  to: string;
  timezone: string;
  bucket: BucketUnit;
  companyId: string | null;
}

@Injectable()
export class ReportContextService {
  constructor(private prisma: PrismaService) {}

  async resolve(orgId: string, q: ReportQueryDto, now: Date = new Date()): Promise<ReportContext> {
    const settings = await this.prisma.systemSettings.findUnique({
      where: { organizationId: orgId },
      select: { timezone: true },
    });
    let range: ReportRange;
    try {
      range = resolveRange(q, settings?.timezone ?? "UTC", now);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Invalid range");
    }
    const unit: BucketUnit = q.bucket ?? chooseBucket(range.days);
    if (unit === "day" && range.days > 366) {
      throw new BadRequestException("Daily buckets are limited to ranges of a year");
    }
    return {
      orgId,
      range,
      unit,
      buckets: buildBuckets(range.from, range.to, unit),
      companyId: q.companyId || null,
      now,
    };
  }
}

export function rangeInfo(ctx: ReportContext): RangeInfo {
  return {
    from: ctx.range.from,
    to: ctx.range.to,
    timezone: ctx.range.timezone,
    bucket: ctx.unit,
    companyId: ctx.companyId,
  };
}

/** `AND <col> = companyId` when the report is filtered to one company. */
export function companyFilter(ctx: ReportContext, col: Prisma.Sql): Prisma.Sql {
  return ctx.companyId ? Prisma.sql`AND ${col} = ${ctx.companyId}` : Prisma.empty;
}
