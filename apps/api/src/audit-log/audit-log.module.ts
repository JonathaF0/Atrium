import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { AuditLogController } from "./audit-log.controller";
import { AuditLogService } from "./audit-log.service";
import { AuditInterceptor } from "./audit.interceptor";
import { AuditRetentionTask } from "./audit-retention.task";

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [AuditLogController],
  providers: [AuditLogService, AuditRetentionTask, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditLogService],
})
export class AuditLogModule {}
