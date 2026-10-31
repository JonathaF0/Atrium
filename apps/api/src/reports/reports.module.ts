import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportContextService } from "./report-context.service";
import { TicketReportsService } from "./ticket-reports.service";
import { HoursReportService } from "./hours-report.service";
import { RevenueReportService } from "./revenue-report.service";

@Module({
  controllers: [ReportsController],
  providers: [ReportContextService, TicketReportsService, HoursReportService, RevenueReportService],
})
export class ReportsModule {}
