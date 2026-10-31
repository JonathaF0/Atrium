import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../service-core";
import { RenewalNotifier, formatDay } from "../assets/renewal-notifier";
import type { RenewalDigest } from "../assets/renewal-notifier";
import { needsRenewalNotice, renewedTerm } from "./contract-period";

const BATCH_SIZE = 1000;
const MAX_NOTICE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

interface NoticeContract {
  id: string;
  organizationId: string;
  name: string;
  endsAt: Date | null;
  autoRenew: boolean;
  renewalNotifiedAt: Date | null;
  company: { name: string };
}

/**
 * Daily: renews auto-renewing contracts that reached their end, expires the rest,
 * and tells owners/admins about contracts entering their renewal notice window
 * (once per term).
 */
@Injectable()
export class ContractRenewalTask {
  private readonly logger = new Logger(ContractRenewalTask.name);

  constructor(
    private prisma: PrismaService,
    private notifier: RenewalNotifier,
    private audit: AuditService,
  ) {}

  @Cron("10 7 * * *")
  async run(): Promise<void> {
    try {
      await this.runOnce(new Date());
    } catch (err) {
      this.logger.error("Contract renewal run failed", err);
    }
  }

  async runOnce(now: Date): Promise<{ renewed: number; expired: number; notified: number }> {
    const renewed = await this.renewDue(now);
    const expired = await this.expireEnded(now);
    const notified = await this.notifyUpcoming(now);
    return { renewed, expired, notified };
  }

  async renewDue(now: Date): Promise<number> {
    const due = await this.prisma.contract.findMany({
      where: { status: "active", autoRenew: true, endsAt: { lte: now } },
      select: { id: true, organizationId: true, name: true, startsAt: true, endsAt: true },
      take: BATCH_SIZE,
    });
    let renewed = 0;
    for (const c of due) {
      const next = renewedTerm(c, now);
      if (!next) continue;
      try {
        const ok = await this.prisma.$transaction(async (tx) => {
          // Compare-and-set on the old end date: a concurrent run renews it only once.
          const { count } = await tx.contract.updateMany({
            where: { id: c.id, status: "active", endsAt: c.endsAt },
            data: { startsAt: next.startsAt, endsAt: next.endsAt, renewalNotifiedAt: null },
          });
          if (count === 0) return false;
          await this.audit.record(
            {
              organizationId: c.organizationId,
              action: "contract.renewed",
              targetType: "contract",
              targetId: c.id,
              summary: `Contract ${c.name} renewed until ${formatDay(next.endsAt)}`,
              metadata: {
                previousStartsAt: c.startsAt.toISOString(),
                previousEndsAt: (c.endsAt as Date).toISOString(),
                startsAt: next.startsAt.toISOString(),
                endsAt: next.endsAt.toISOString(),
                renewals: next.renewals,
              },
            },
            tx,
          );
          return true;
        });
        if (ok) renewed++;
      } catch (err) {
        this.logger.error(`Contract renewal failed for ${c.id}`, err);
      }
    }
    return renewed;
  }

  async expireEnded(now: Date): Promise<number> {
    const ended = await this.prisma.contract.findMany({
      where: { status: "active", autoRenew: false, endsAt: { lte: now } },
      select: { id: true, organizationId: true, name: true },
      take: BATCH_SIZE,
    });
    let expired = 0;
    for (const c of ended) {
      const { count } = await this.prisma.contract.updateMany({
        where: { id: c.id, status: "active", autoRenew: false },
        data: { status: "expired" },
      });
      if (count === 0) continue;
      expired++;
      await this.audit.record({
        organizationId: c.organizationId,
        action: "contract.expired",
        targetType: "contract",
        targetId: c.id,
        summary: `Contract ${c.name} expired`,
      });
    }
    return expired;
  }

  async notifyUpcoming(now: Date): Promise<number> {
    const rows = await this.prisma.contract.findMany({
      where: {
        status: "active",
        endsAt: { gt: now, lte: new Date(now.getTime() + MAX_NOTICE_DAYS * DAY_MS) },
        renewalNotifiedAt: null,
      },
      select: {
        id: true,
        organizationId: true,
        name: true,
        status: true,
        startsAt: true,
        endsAt: true,
        autoRenew: true,
        renewalNoticeDays: true,
        renewalNotifiedAt: true,
        company: { select: { name: true } },
      },
      orderBy: { endsAt: "asc" },
      take: BATCH_SIZE,
    });
    const byOrg = new Map<string, NoticeContract[]>();
    for (const c of rows) {
      if (!needsRenewalNotice(c, now)) continue;
      byOrg.set(c.organizationId, [...(byOrg.get(c.organizationId) ?? []), c]);
    }

    let notified = 0;
    for (const [orgId, contracts] of byOrg) {
      try {
        const recipients = await this.notifier.staff(orgId);
        const claimed = await this.prisma.$transaction(async (tx) => {
          const taken: NoticeContract[] = [];
          for (const c of contracts) {
            const { count } = await tx.contract.updateMany({
              where: { id: c.id, renewalNotifiedAt: null, endsAt: c.endsAt },
              data: { renewalNotifiedAt: now },
            });
            if (count === 1) taken.push(c);
          }
          if (taken.length > 0 && recipients.length > 0) {
            await this.notifier.inAppDigest(orgId, recipients, contractDigest(taken), tx);
          }
          return taken;
        });
        if (claimed.length === 0) continue;
        await this.notifier.emailDigest(orgId, recipients, contractDigest(claimed));
        notified += claimed.length;
      } catch (err) {
        this.logger.error(`Contract renewal notice failed for org ${orgId}`, err);
      }
    }
    return notified;
  }
}

export function contractDigest(contracts: NoticeContract[]): RenewalDigest {
  const n = contracts.length;
  const noun = n === 1 ? "contract" : "contracts";
  const detail = (c: NoticeContract): string =>
    `${c.company.name} · ${c.autoRenew ? "renews automatically" : "ends"} ${formatDay(c.endsAt as Date)}`;
  return {
    type: "contract_renewal",
    title: n === 1 ? `Contract ending soon: ${contracts[0].name}` : `${n} contracts ending soon`,
    message: n === 1 ? detail(contracts[0]) : contracts.slice(0, 3).map((c) => c.name).join(", ") + (n > 3 ? ` and ${n - 3} more` : ""),
    link: "/dashboard/contracts",
    subject: n === 1 ? `Contract ending soon: ${contracts[0].name}` : `${n} ${noun} ending soon`,
    heading: n === 1 ? "A contract is ending soon" : `${n} ${noun} are ending soon`,
    intro: "Review these service agreements before their end date.",
    listLabel: "Open contracts",
    items: contracts.map((c) => ({ title: c.name, detail: detail(c), path: `/dashboard/contracts/${c.id}` })),
  };
}
