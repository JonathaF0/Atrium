import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { EstimateNotificationsService } from "./estimate-notifications.service";
import { EXPIRABLE_STATUSES, estimateTotals } from "./estimate-math";

const BATCH_SIZE = 200;
const DAY_MS = 86_400_000;
export const DEFAULT_REMINDER_DAYS = 3;

export function reminderDays(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n <= 60 ? n : DEFAULT_REMINDER_DAYS;
}

/**
 * Daily: expires sent estimates past their validity date and reminds the
 * recipient once, N days before expiry. Every row is claimed with a guarded
 * update, so several API replicas running this at once never double-process.
 */
@Injectable()
export class EstimatesTask {
  private readonly logger = new Logger(EstimatesTask.name);
  private readonly reminderDays: number;

  constructor(
    private prisma: PrismaService,
    private notifications: EstimateNotificationsService,
    config: ConfigService,
  ) {
    this.reminderDays = reminderDays(config.get<string>("ESTIMATE_REMINDER_DAYS"));
  }

  @Cron("10 6 * * *")
  async run(): Promise<void> {
    const now = new Date();
    try {
      const expired = await this.expire(now);
      const reminded = await this.remind(now);
      if (expired || reminded) this.logger.log(`Estimates: ${expired} expired, ${reminded} reminder(s) sent`);
    } catch (err) {
      this.logger.error("Estimate expiry run failed", err);
    }
  }

  async expire(now: Date): Promise<number> {
    const due = await this.prisma.estimate.findMany({
      where: { status: { in: [...EXPIRABLE_STATUSES] }, validUntil: { lt: now } },
      select: { id: true },
      take: BATCH_SIZE,
    });
    let count = 0;
    for (const { id } of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const res = await tx.estimate.updateMany({
          where: { id, status: { in: [...EXPIRABLE_STATUSES] }, validUntil: { lt: now } },
          data: { status: "expired" },
        });
        if (res.count === 0) return false;
        await tx.estimateEvent.create({ data: { estimateId: id, action: "expired" } });
        return true;
      });
      if (done) count++;
    }
    return count;
  }

  async remind(now: Date): Promise<number> {
    if (this.reminderDays <= 0) return 0;
    const horizon = new Date(now.getTime() + this.reminderDays * DAY_MS);
    const due = await this.prisma.estimate.findMany({
      where: {
        status: { in: [...EXPIRABLE_STATUSES] },
        expiryReminderSentAt: null,
        recipientUserId: { not: null },
        validUntil: { gte: now, lte: horizon },
      },
      include: { lineItems: true },
      take: BATCH_SIZE,
    });
    let count = 0;
    for (const e of due) {
      // Claim first: a replica that loses the race skips it, and a failed send is not retried (one reminder only).
      const { count: claimed } = await this.prisma.estimate.updateMany({
        where: { id: e.id, expiryReminderSentAt: null },
        data: { expiryReminderSentAt: now },
      });
      if (claimed === 0) continue;
      const sent = await this.notifications.sendReminder(e, estimateTotals(e.lineItems, e).totalCents);
      await this.prisma.estimateEvent.create({
        data: { estimateId: e.id, action: "reminder_sent", detail: sent ? null : "Email could not be delivered" },
      });
      if (sent) count++;
    }
    return count;
  }
}
