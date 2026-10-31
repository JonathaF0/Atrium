import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { RecurringGeneratorService } from "./recurring-generator.service";

@Injectable()
export class RecurringInvoicesTask {
  private readonly logger = new Logger(RecurringInvoicesTask.name);
  private running = false;

  constructor(private generator: RecurringGeneratorService) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const created = await this.generator.runDue(new Date());
      if (created > 0) this.logger.log(`Generated ${created} recurring invoice(s)`);
    } catch (err) {
      this.logger.error("Recurring invoice run failed", err instanceof Error ? err.stack : String(err));
    } finally {
      this.running = false;
    }
  }
}
