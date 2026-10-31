import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AuditLogService } from "./audit-log.service";

/** Daily: drops audit entries older than AUDIT_LOG_RETENTION_DAYS (0 keeps them forever). */
@Injectable()
export class AuditRetentionTask {
  private readonly logger = new Logger(AuditRetentionTask.name);

  constructor(private auditLog: AuditLogService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async run(): Promise<void> {
    try {
      const count = await this.auditLog.prune(new Date());
      if (count > 0) this.logger.log(`Pruned ${count} audit log entries past retention`);
    } catch (err) {
      this.logger.error("Audit log retention run failed", err instanceof Error ? err.stack : String(err));
    }
  }
}
