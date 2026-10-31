import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../service-core";
import { isPrismaUniqueViolation } from "../common/helpers/prisma-errors";
import { RecurringNotificationsService } from "./recurring-notifications.service";
import { RecurringStripeService } from "./recurring-stripe.service";
import { formatPeriod, periodFor, prorate, startOfUtcDay } from "./schedule";

const DAY_MS = 86_400_000;
const BATCH_SIZE = 100;
/** Periods one schedule may catch up on in a single cron tick (e.g. after downtime). */
const MAX_CATCH_UP = 12;

export interface GeneratedRun {
  scheduleId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  ended: boolean;
}

/** Next "INV-0001" style number, the same scheme InvoicesService uses. */
export async function nextInvoiceNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  const last = await tx.invoice.findFirst({
    where: { organizationId },
    orderBy: { invoiceNumber: "desc" },
    select: { invoiceNumber: true },
  });
  let next = 1;
  const match = last?.invoiceNumber.match(/INV-(\d+)/);
  if (match) next = parseInt(match[1], 10) + 1;
  return `INV-${String(next).padStart(4, "0")}`;
}

/**
 * Turns due billing schedules into invoices. A run claims its schedule row
 * with `FOR UPDATE SKIP LOCKED` and advances `nextRunAt` in the same
 * transaction that creates the invoice, so concurrent runs (cron on several
 * replicas, or "run now" racing the cron) produce exactly one invoice per period.
 */
@Injectable()
export class RecurringGeneratorService {
  private readonly logger = new Logger(RecurringGeneratorService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notices: RecurringNotificationsService,
    private stripe: RecurringStripeService,
  ) {}

  /** Generates every due invoice. Returns how many invoices were created. */
  async runDue(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.recurringInvoice.findMany({
      where: { status: "active", nextRunAt: { lte: now } },
      select: { id: true },
      orderBy: { nextRunAt: "asc" },
      take: BATCH_SIZE,
    });
    let created = 0;
    for (const { id } of due) {
      for (let i = 0; i < MAX_CATCH_UP; i++) {
        try {
          const run = await this.generate(id, now, { force: false });
          if (!run) break;
          if (run.invoiceId) created++;
          if (run.ended) break;
        } catch (err) {
          this.logger.error(`Recurring invoice run failed for schedule ${id}`, err instanceof Error ? err.stack : String(err));
          break;
        }
      }
    }
    return created;
  }

  /**
   * One run. `force` bills the next period now even if it is not due yet (the
   * "run now" button). Returns null when the schedule is not active, not due,
   * or another run holds it.
   */
  async generate(scheduleId: string, now: Date, opts: { force: boolean; actorId?: string | null }): Promise<GeneratedRun | null> {
    let run: GeneratedRun | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        run = await this.prisma.$transaction((tx) => this.generateInTx(tx, scheduleId, now, opts.force));
        break;
      } catch (err) {
        // Another invoice took the same number between our read and insert.
        if (isPrismaUniqueViolation(err) && attempt < 3) continue;
        throw err;
      }
    }
    if (run?.invoiceId) await this.afterCreate(run, opts.actorId ?? null);
    return run;
  }

  private async generateInTx(
    tx: Prisma.TransactionClient,
    scheduleId: string,
    now: Date,
    force: boolean,
  ): Promise<GeneratedRun | null> {
    const dueClause = force ? Prisma.empty : Prisma.sql`AND "nextRunAt" <= ${now}`;
    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM recurring_invoice
      WHERE id = ${scheduleId} AND status = 'active' ${dueClause}
      FOR UPDATE SKIP LOCKED`;
    if (claimed.length === 0) return null;

    const schedule = await tx.recurringInvoice.findUnique({
      where: { id: scheduleId },
      include: { items: { orderBy: { order: "asc" } } },
    });
    if (!schedule) return null;

    const runAt = startOfUtcDay(schedule.nextRunAt);
    if (schedule.endDate && runAt.getTime() > schedule.endDate.getTime()) {
      await tx.recurringInvoice.update({ where: { id: schedule.id }, data: { status: "ended" } });
      return { scheduleId, invoiceId: null, invoiceNumber: null, ended: true };
    }

    const period = periodFor(schedule, runAt, schedule.lastRunAt === null);
    const label = formatPeriod(period);
    const prorated = period.factor < 1;
    const invoiceNumber = await nextInvoiceNumber(tx, schedule.organizationId);
    const notes = [`${schedule.name}: ${label}${prorated ? " (prorated)" : ""}`, schedule.notes].filter(Boolean).join("\n\n");

    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber,
        status: schedule.autoSend ? "sent" : "draft",
        dueDate: new Date(startOfUtcDay(now).getTime() + schedule.dueDays * DAY_MS + DAY_MS / 2),
        notes: notes.slice(0, 2000),
        projectId: schedule.projectId,
        organizationId: schedule.organizationId,
        recurringInvoiceId: schedule.id,
        lineItems: {
          create: schedule.items.map((item) => ({
            description: (prorated ? `${item.description} (prorated ${label})` : item.description).slice(0, 500),
            quantity: item.quantity,
            unitPrice: prorate(item.unitPrice, period.factor),
            taxRateBps: item.taxRateBps,
          })),
        },
      },
      select: { id: true },
    });

    const ended = !!schedule.endDate && period.end.getTime() > schedule.endDate.getTime();
    await tx.recurringInvoice.update({
      where: { id: schedule.id },
      data: { nextRunAt: period.end, lastRunAt: now, ...(ended ? { status: "ended" } : {}) },
    });
    return { scheduleId, invoiceId: invoice.id, invoiceNumber, ended };
  }

  private async afterCreate(run: GeneratedRun, actorId: string | null): Promise<void> {
    const schedule = await this.prisma.recurringInvoice.findUnique({ where: { id: run.scheduleId } });
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: run.invoiceId as string },
      include: { lineItems: true },
    });
    if (!schedule || !invoice) return;

    await this.audit.record({
      organizationId: schedule.organizationId,
      actorId,
      action: "recurring_invoice.generated",
      targetType: "invoice",
      targetId: invoice.id,
      summary: `Generated ${invoice.invoiceNumber} from "${schedule.name}"`,
      metadata: { recurringInvoiceId: schedule.id, status: invoice.status },
    });

    if (invoice.status !== "sent") return;
    try {
      await this.notices.invoiceSent(invoice.id);
    } catch (err) {
      this.logger.warn(`Failed to notify about ${invoice.invoiceNumber}: ${String(err)}`);
    }

    const outcome = await this.stripe.chargeInvoice(schedule, invoice);
    if (outcome.status === "skipped") return;
    await this.audit.record({
      organizationId: schedule.organizationId,
      actorId: null,
      action: outcome.status === "failed" ? "recurring_invoice.charge_failed" : "recurring_invoice.charged",
      targetType: "invoice",
      targetId: invoice.id,
      summary:
        outcome.status === "failed"
          ? `Automatic charge for ${invoice.invoiceNumber} failed`
          : `Charged ${invoice.invoiceNumber} to the saved card`,
      metadata: outcome.status === "failed" ? { reason: outcome.reason } : { paymentIntentId: outcome.paymentIntentId, status: outcome.status },
    });
    if (outcome.status === "failed") {
      await this.notices.chargeFailed(schedule.organizationId, invoice.invoiceNumber, outcome.reason).catch(() => undefined);
    }
  }
}
