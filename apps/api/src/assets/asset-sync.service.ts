import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../service-core";
import { MAX_SYNC_BATCH, SYNC_SOURCE_PATTERN, planSync } from "./asset-sync";
import type { AssetWriteData, SyncAssetInput, SyncError } from "./asset-sync";
import { jsonValue } from "./assets.service";
import type { AssetActor } from "./assets.service";

export interface SyncResult {
  source: string;
  created: number;
  updated: number;
  retired: number;
  errors: SyncError[];
}

function writeData(data: AssetWriteData) {
  return { ...data, metadata: jsonValue(data.metadata) };
}

/**
 * Upserts assets pushed by an external inventory (RMM, PSA, MDM) on
 * (organizationId, externalSource, externalId). See `PUT /assets/sync/:source`.
 */
@Injectable()
export class AssetSyncService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async sync(
    orgId: string,
    source: string,
    items: SyncAssetInput[],
    fullSync: boolean,
    actor: AssetActor,
  ): Promise<SyncResult> {
    const src = source.trim().toLowerCase();
    if (!SYNC_SOURCE_PATTERN.test(src) || src === "csv") {
      throw new BadRequestException("source must be 1-50 lowercase letters, digits, dots, dashes or underscores (not \"csv\")");
    }
    if (items.length > MAX_SYNC_BATCH) throw new BadRequestException(`At most ${MAX_SYNC_BATCH} assets per batch`);
    if (fullSync && items.length === 0) {
      throw new BadRequestException("A full sync needs at least one asset; it would otherwise retire every asset of the source");
    }

    const companyIds = [...new Set(items.map((i) => i.companyId).filter((v): v is string => !!v))];
    const companyNames = [...new Set(items.map((i) => i.companyName?.trim()).filter((v): v is string => !!v))];
    const [companies, existing] = await Promise.all([
      this.prisma.company.findMany({
        where: {
          organizationId: orgId,
          OR: [
            ...(companyIds.length ? [{ id: { in: companyIds } }] : []),
            ...(companyNames.length ? companyNames.map((name) => ({ name: { equals: name, mode: "insensitive" as const } })) : []),
          ],
        },
        select: { id: true, name: true },
      }),
      this.prisma.asset.findMany({
        where: { organizationId: orgId, externalSource: src, externalId: { in: items.map((i) => i.externalId) } },
        select: { id: true, externalId: true, status: true },
      }),
    ]);

    const plan = planSync(
      items,
      existing.map((a) => ({ id: a.id, externalId: a.externalId as string, status: a.status })),
      companies,
    );

    const retired = await this.prisma.$transaction(
      async (tx) => {
        for (const c of plan.creates) {
          await tx.asset.create({
            data: { organizationId: orgId, externalSource: src, externalId: c.externalId, ...writeData(c.data) },
          });
        }
        for (const u of plan.updates) {
          await tx.asset.update({ where: { id: u.id }, data: writeData(u.data) });
        }
        if (!fullSync) return 0;
        const { count } = await tx.asset.updateMany({
          where: {
            organizationId: orgId,
            externalSource: src,
            externalId: { notIn: plan.keepExternalIds },
            status: { not: "retired" },
          },
          data: { status: "retired" },
        });
        return count;
      },
      { timeout: 60_000 },
    );

    const result: SyncResult = {
      source: src,
      created: plan.creates.length,
      updated: plan.updates.length,
      retired,
      errors: plan.errors,
    };
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "asset.synced",
      targetType: "asset",
      summary: `Asset sync from ${src}: ${result.created} created, ${result.updated} updated, ${retired} retired, ${plan.errors.length} rejected`,
      metadata: { source: src, fullSync, created: result.created, updated: result.updated, retired, rejected: plan.errors.length },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return result;
  }
}
