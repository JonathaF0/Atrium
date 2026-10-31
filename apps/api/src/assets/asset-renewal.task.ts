import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { ASSET_TYPE_LABELS } from "@atrium/shared";
import type { AssetType } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EXPIRING_ASSET_TYPES, dueRenewalDates } from "./asset-fields";
import type { RenewalDate } from "./asset-fields";
import { RenewalNotifier, formatDay } from "./renewal-notifier";
import type { RenewalDigest } from "./renewal-notifier";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 5000;
export const DEFAULT_ASSET_NOTICE_DAYS = 30;

export function assetNoticeDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_ASSET_NOTICE_DAYS;
}

interface DueAsset {
  id: string;
  organizationId: string;
  name: string;
  type: string;
  renewalNotifiedAt: Date | null;
  company: { name: string };
  dates: RenewalDate[];
}

function describe(asset: DueAsset): string {
  const parts = asset.dates.map((d) => `${d.kind === "warranty" ? "warranty ends" : "renews"} ${formatDay(d.date)}`);
  const type = ASSET_TYPE_LABELS[asset.type as AssetType] ?? asset.type;
  return `${asset.company.name} · ${type} · ${parts.join(", ")}`;
}

/**
 * Daily: flags lapsed licenses, certificates and domains as expired, and sends
 * owners/admins one digest of assets whose warranty or renewal date is coming up.
 */
@Injectable()
export class AssetRenewalTask {
  private readonly logger = new Logger(AssetRenewalTask.name);

  constructor(
    private prisma: PrismaService,
    private notifier: RenewalNotifier,
    private config: ConfigService,
  ) {}

  @Cron("0 7 * * *")
  async run(): Promise<void> {
    try {
      await this.runOnce(new Date());
    } catch (err) {
      this.logger.error("Asset renewal run failed", err);
    }
  }

  async runOnce(now: Date): Promise<{ expired: number; notified: number }> {
    const expired = await this.expireLapsed(now);
    const notified = await this.notifyDue(now);
    return { expired, notified };
  }

  /** Idempotent, so concurrent replicas can both run it. */
  async expireLapsed(now: Date): Promise<number> {
    const { count } = await this.prisma.asset.updateMany({
      where: {
        type: { in: [...EXPIRING_ASSET_TYPES] },
        status: "active",
        OR: [{ renewsAt: { lt: now } }, { renewsAt: null, warrantyEndsAt: { lt: now } }],
      },
      data: { status: "expired" },
    });
    return count;
  }

  /** Returns how many assets were notified about. */
  async notifyDue(now: Date): Promise<number> {
    const days = assetNoticeDays(this.config.get<string>("ASSET_RENEWAL_NOTICE_DAYS"));
    const range = { gte: now, lte: new Date(now.getTime() + days * DAY_MS) };
    const rows = await this.prisma.asset.findMany({
      where: { status: { not: "retired" }, OR: [{ warrantyEndsAt: range }, { renewsAt: range }] },
      select: {
        id: true,
        organizationId: true,
        name: true,
        type: true,
        status: true,
        warrantyEndsAt: true,
        renewsAt: true,
        renewalNotifiedAt: true,
        company: { select: { name: true } },
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });

    const byOrg = new Map<string, DueAsset[]>();
    for (const row of rows) {
      const dates = dueRenewalDates(row, now, days);
      if (dates.length === 0) continue;
      byOrg.set(row.organizationId, [...(byOrg.get(row.organizationId) ?? []), { ...row, dates }]);
    }

    let notified = 0;
    for (const [orgId, assets] of byOrg) {
      try {
        notified += await this.notifyOrg(orgId, assets, now, days);
      } catch (err) {
        this.logger.error(`Asset renewal notice failed for org ${orgId}`, err);
      }
    }
    return notified;
  }

  private async notifyOrg(orgId: string, assets: DueAsset[], now: Date, days: number): Promise<number> {
    const recipients = await this.notifier.staff(orgId);
    // Claim each asset by compare-and-set on renewalNotifiedAt, so a concurrent run
    // (another replica) skips what this one took; the in-app rows commit with the claims.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const taken: DueAsset[] = [];
      for (const a of assets) {
        const { count } = await tx.asset.updateMany({
          where: { id: a.id, renewalNotifiedAt: a.renewalNotifiedAt },
          data: { renewalNotifiedAt: now },
        });
        if (count === 1) taken.push(a);
      }
      if (taken.length > 0 && recipients.length > 0) {
        await this.notifier.inAppDigest(orgId, recipients, this.digest(taken, days), tx);
      }
      return taken;
    });
    if (claimed.length === 0) return 0;
    await this.notifier.emailDigest(orgId, recipients, this.digest(claimed, days));
    return claimed.length;
  }

  digest(assets: DueAsset[], days: number): RenewalDigest {
    const n = assets.length;
    const noun = n === 1 ? "asset" : "assets";
    return {
      type: "asset_renewal",
      title: `${n} ${noun} up for renewal`,
      message:
        n === 1
          ? `${assets[0].name}: ${describe(assets[0])}`
          : `${assets.slice(0, 3).map((a) => a.name).join(", ")}${n > 3 ? ` and ${n - 3} more` : ""}`,
      link: `/dashboard/assets?expiring=${days}`,
      subject: `${n} ${noun} up for renewal in the next ${days} days`,
      heading: `${n} ${noun} up for renewal`,
      intro: `These warranties, licenses and subscriptions end within ${days} days.`,
      listLabel: "Open assets",
      items: assets.map((a) => ({ title: a.name, detail: describe(a), path: `/dashboard/assets?asset=${a.id}` })),
    };
  }
}
