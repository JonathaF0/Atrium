import { Prisma } from "@atrium/database";
import type { BucketUnit } from "./report-range";

/**
 * Prisma stores DateTime as `timestamp` (no zone) holding UTC. Passing the ISO
 * string and casting keeps comparisons independent of the session TimeZone.
 */
export function ts(d: Date): Prisma.Sql {
  return Prisma.sql`${d.toISOString()}::timestamp`;
}

/** A stored UTC timestamp as local wall-clock time in `tz`. */
export function localTime(col: Prisma.Sql, tz: string): Prisma.Sql {
  return Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${tz})`;
}

/** Bucket key (YYYY-MM-DD of the bucket's first local day) for a stored timestamp. */
export function bucketKeySql(col: Prisma.Sql, unit: BucketUnit, tz: string): Prisma.Sql {
  return Prisma.sql`to_char(date_trunc(${unit}, ${localTime(col, tz)}), 'YYYY-MM-DD')`;
}

/** `col` within [start, end). */
export function inRange(col: Prisma.Sql, start: Date, end: Date): Prisma.Sql {
  return Prisma.sql`(${col} >= ${ts(start)} AND ${col} < ${ts(end)})`;
}

/**
 * LATERAL subquery yielding `"companyId"` for a project: the company of the
 * project's client contacts (a current link first, then the oldest). Used for
 * time entries and invoices that carry no company of their own.
 */
export function projectCompanyLateral(projectId: Prisma.Sql, orgId: string): Prisma.Sql {
  return Prisma.sql`LEFT JOIN LATERAL (
    SELECT c."companyId"
    FROM "project_contact" pc
    JOIN "contact" c ON c.id = pc."contactId" AND c."organizationId" = ${orgId}
    WHERE pc."projectId" = ${projectId} AND c."companyId" IS NOT NULL
    ORDER BY (pc."endedAt" IS NULL) DESC, pc."createdAt" ASC
    LIMIT 1
  )`;
}

/** Postgres counts and sums arrive as bigint/Decimal; reports use plain numbers. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return Number(String(v));
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

/** Hours rounded to two decimals, or null. */
export function hours(v: unknown): number | null {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n * 100) / 100;
}
