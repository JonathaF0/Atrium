import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../service-core";
import { RecurringNotificationsService } from "./recurring-notifications.service";
import { dueDunningStage, overdueDays, parseDunningDays } from "./schedule";

const BATCH_SIZE = 500;
const DAY_MS = 86_400_000;
/** Invoices overdue longer than this get no automatic reminders (old debt is handled by hand). */
const MAX_OVERDUE_DAYS = 180;

/**
 * Overdue reminders ("dunning"). InvoiceOverdueTask flips sent invoices to
 * `overdue`; this task only sends reminders, at the day offsets in
 * DUNNING_DAYS (default 3, 7 and 14 days after the due date). Each reminder is
 * claimed by a conditional update on `dunningStage`, so replicas never send
 * the same reminder twice.
 */
@Injectable()
export class DunningTask {
  private readonly logger = new Logger(DunningTask.name);
  private readonly stages: number[];

  constructor(
    private prisma: PrismaService,
    private notices: RecurringNotificationsService,
    private audit: AuditService,
    config: ConfigService,
  ) {
    this.stages = parseDunningDays(config.get<string>("DUNNING_DAYS"));
  }

  @Cron(CronExpression.EVERY_DAY_AT_10AM)
  async run(): Promise<void> {
    try {
      const sent = await this.sendDue(new Date());
      if (sent > 0) this.logger.log(`Sent ${sent} overdue invoice reminder(s)`);
    } catch (err) {
      this.logger.error("Dunning run failed", err instanceof Error ? err.stack : String(err));
    }
  }

  /** Returns how many invoices got a reminder. */
  async sendDue(now: Date): Promise<number> {
    if (this.stages.length === 0) return 0;
    const first = this.stages[0];
    const invoices = await this.prisma.invoice.findMany({
      where: {
        status: { in: ["sent", "overdue"] },
        dueDate: { lte: new Date(now.getTime() - first * DAY_MS), gte: new Date(now.getTime() - MAX_OVERDUE_DAYS * DAY_MS) },
        dunningStage: { lt: this.stages.length },
      },
      select: { id: true, organizationId: true, invoiceNumber: true, dueDate: true, dunningStage: true },
      orderBy: { dueDate: "asc" },
      take: BATCH_SIZE,
    });

    let reminded = 0;
    for (const invoice of invoices) {
      if (!invoice.dueDate) continue;
      const stage = dueDunningStage(invoice.dueDate, now, this.stages, invoice.dunningStage);
      if (stage === null) continue;
      const { count } = await this.prisma.invoice.updateMany({
        where: { id: invoice.id, dunningStage: invoice.dunningStage, status: { in: ["sent", "overdue"] } },
        data: { dunningStage: stage, lastDunningAt: now },
      });
      if (count === 0) continue;
      try {
        const days = overdueDays(invoice.dueDate, now);
        const emails = await this.notices.overdueReminder(invoice.id, stage, days);
        await this.audit.record({
          organizationId: invoice.organizationId,
          action: "invoice.reminder_sent",
          targetType: "invoice",
          targetId: invoice.id,
          summary: `Overdue reminder ${stage} for ${invoice.invoiceNumber} (${days} days overdue)`,
          metadata: { stage, daysOverdue: days, emails },
        });
        reminded++;
      } catch (err) {
        this.logger.error(`Overdue reminder failed for invoice ${invoice.id}`, err instanceof Error ? err.stack : String(err));
      }
    }
    return reminded;
  }
}
