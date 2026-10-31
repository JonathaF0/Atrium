import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../service-core";
import { AnnouncementNotificationsService } from "./announcement-notifications.service";
import { MAINTENANCE_GRACE_MS, dueAction, reminderDue } from "./announcement-state";

const BATCH = 100;
export const DEFAULT_REMINDER_HOURS = 24;

export function reminderHours(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 24 * 30 ? n : DEFAULT_REMINDER_HOURS;
}

/**
 * Publishes scheduled announcements, expires old ones and sends maintenance
 * reminders. Every change is claimed with a conditional update, so several
 * API instances running this at once still act on each row exactly once.
 */
@Injectable()
export class AnnouncementsTask {
  private readonly logger = new Logger(AnnouncementsTask.name);
  private readonly reminderHours: number;
  private running = false;

  constructor(
    private prisma: PrismaService,
    private notifier: AnnouncementNotificationsService,
    private audit: AuditService,
    config: ConfigService,
  ) {
    this.reminderHours = reminderHours(config.get<string>("MAINTENANCE_REMINDER_HOURS"));
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      await this.publishDue(now);
      await this.expireDue(now);
      await this.sendReminders(now);
    } catch (err) {
      this.logger.error("Announcement scheduler run failed", err instanceof Error ? err.stack : String(err));
    } finally {
      this.running = false;
    }
  }

  async publishDue(now: Date): Promise<number> {
    const due = await this.prisma.announcement.findMany({
      where: { status: "scheduled", publishAt: { lte: now } },
      include: { audiences: { select: { companyId: true } } },
      orderBy: { publishAt: "asc" },
      take: BATCH,
    });
    let published = 0;
    for (const a of due) {
      if (dueAction(a, now) !== "publish") continue;
      const { count } = await this.prisma.announcement.updateMany({
        where: { id: a.id, status: "scheduled", publishAt: a.publishAt },
        data: { status: "published", publishedAt: now },
      });
      if (count === 0) continue;
      published++;
      await this.audit.record({
        organizationId: a.organizationId,
        action: "announcement.published",
        targetType: "announcement",
        targetId: a.id,
        summary: `Published scheduled announcement "${a.title}"`,
        metadata: { scheduled: true },
      });
      try {
        await this.notifier.published(a, null);
      } catch (err) {
        this.logger.error(`Failed to notify for announcement ${a.id}`, err instanceof Error ? err.stack : String(err));
      }
    }
    return published;
  }

  async expireDue(now: Date): Promise<number> {
    const graceCutoff = new Date(now.getTime() - MAINTENANCE_GRACE_MS);
    const due = await this.prisma.announcement.findMany({
      where: {
        status: "published",
        OR: [
          { expiresAt: { lte: now } },
          { expiresAt: null, type: "maintenance", windowEnd: { lte: graceCutoff } },
        ],
      },
      take: BATCH,
    });
    let expired = 0;
    for (const a of due) {
      if (dueAction(a, now) !== "expire") continue;
      const { count } = await this.prisma.announcement.updateMany({
        where: { id: a.id, status: "published" },
        data: { status: "expired" },
      });
      if (count === 0) continue;
      expired++;
      await this.audit.record({
        organizationId: a.organizationId,
        action: "announcement.expired",
        targetType: "announcement",
        targetId: a.id,
        summary: `Announcement "${a.title}" expired`,
      });
    }
    return expired;
  }

  async sendReminders(now: Date): Promise<number> {
    const horizon = new Date(now.getTime() + this.reminderHours * 3_600_000);
    const due = await this.prisma.announcement.findMany({
      where: {
        status: "published",
        type: "maintenance",
        reminderSentAt: null,
        windowStart: { gt: now, lte: horizon },
      },
      include: { audiences: { select: { companyId: true } } },
      take: BATCH,
    });
    let sent = 0;
    for (const a of due) {
      if (!reminderDue(a, now, this.reminderHours)) continue;
      const { count } = await this.prisma.announcement.updateMany({
        where: { id: a.id, reminderSentAt: null, status: "published" },
        data: { reminderSentAt: now },
      });
      if (count === 0) continue;
      // Published inside the reminder window: the publish notice already told everyone.
      const windowOpensAt = (a.windowStart as Date).getTime() - this.reminderHours * 3_600_000;
      if (a.publishedAt && a.publishedAt.getTime() >= windowOpensAt) continue;
      sent++;
      try {
        await this.notifier.maintenanceReminder(a);
      } catch (err) {
        this.logger.error(`Failed to send reminder for announcement ${a.id}`, err instanceof Error ? err.stack : String(err));
      }
    }
    return sent;
  }
}
