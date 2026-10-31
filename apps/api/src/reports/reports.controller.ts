import { Controller, Get, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { AuthGuard, RolesGuard, Roles, CurrentOrg, CurrentUser, contentDisposition } from "../common";
import { AuditService, auditContext } from "../service-core";
import { ReportQueryDto, SlaExportQueryDto } from "./reports.dto";
import { ReportContextService } from "./report-context.service";
import type { ReportContext } from "./report-context.service";
import { TicketReportsService } from "./ticket-reports.service";
import type { CsatReport, ResponseTimesReport, SlaReport, TicketVolumeReport } from "./ticket-reports.service";
import { HoursReportService } from "./hours-report.service";
import type { HoursReport } from "./hours-report.service";
import { RevenueReportService } from "./revenue-report.service";
import type { RevenueReport } from "./revenue-report.service";
import {
  csatCsv,
  hoursCsv,
  responseTimesCsv,
  revenueCsv,
  slaBreachedCsv,
  slaSummaryCsv,
  ticketVolumeCsv,
} from "./reports-csv";

const EXPORT_THROTTLE = { default: { limit: 10, ttl: 60000 } };

@Controller("reports")
@UseGuards(AuthGuard, RolesGuard)
@Roles("owner", "admin")
export class ReportsController {
  constructor(
    private contexts: ReportContextService,
    private tickets: TicketReportsService,
    private hoursReports: HoursReportService,
    private revenueReports: RevenueReportService,
    private audit: AuditService,
  ) {}

  @Get("tickets")
  async ticketVolume(@CurrentOrg("id") orgId: string, @Query() q: ReportQueryDto): Promise<TicketVolumeReport> {
    return this.tickets.volume(await this.contexts.resolve(orgId, q));
  }

  @Get("sla")
  async sla(@CurrentOrg("id") orgId: string, @Query() q: ReportQueryDto): Promise<SlaReport> {
    return this.tickets.sla(await this.contexts.resolve(orgId, q));
  }

  @Get("response-times")
  async responseTimes(@CurrentOrg("id") orgId: string, @Query() q: ReportQueryDto): Promise<ResponseTimesReport> {
    return this.tickets.responseTimes(await this.contexts.resolve(orgId, q));
  }

  @Get("csat")
  async csat(@CurrentOrg("id") orgId: string, @Query() q: ReportQueryDto): Promise<CsatReport> {
    return this.tickets.csat(await this.contexts.resolve(orgId, q));
  }

  @Get("hours")
  async hours(@CurrentOrg("id") orgId: string, @Query() q: ReportQueryDto): Promise<HoursReport> {
    return this.hoursReports.hours(await this.contexts.resolve(orgId, q));
  }

  @Get("revenue")
  async revenue(@CurrentOrg("id") orgId: string, @Query() q: ReportQueryDto): Promise<RevenueReport> {
    return this.revenueReports.revenue(await this.contexts.resolve(orgId, q));
  }

  // Exports re-run the aggregate queries; throttle them below the global limit.

  @Throttle(EXPORT_THROTTLE)
  @Get("tickets/export")
  async exportTickets(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Query() q: ReportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.contexts.resolve(orgId, q);
    await this.send(res, req, ctx, userId, "tickets", ticketVolumeCsv(await this.tickets.volume(ctx)));
  }

  @Throttle(EXPORT_THROTTLE)
  @Get("sla/export")
  async exportSla(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Query() q: SlaExportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.contexts.resolve(orgId, q);
    if (q.table === "breached") {
      const { rows } = await this.tickets.breachedTickets(ctx, 10000);
      await this.send(res, req, ctx, userId, "sla-breaches", slaBreachedCsv(rows));
      return;
    }
    await this.send(res, req, ctx, userId, "sla", slaSummaryCsv(await this.tickets.sla(ctx)));
  }

  @Throttle(EXPORT_THROTTLE)
  @Get("response-times/export")
  async exportResponseTimes(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Query() q: ReportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.contexts.resolve(orgId, q);
    await this.send(res, req, ctx, userId, "response-times", responseTimesCsv(await this.tickets.responseTimes(ctx)));
  }

  @Throttle(EXPORT_THROTTLE)
  @Get("csat/export")
  async exportCsat(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Query() q: ReportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.contexts.resolve(orgId, q);
    await this.send(res, req, ctx, userId, "csat", csatCsv(await this.tickets.csat(ctx)));
  }

  @Throttle(EXPORT_THROTTLE)
  @Get("hours/export")
  async exportHours(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Query() q: ReportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.contexts.resolve(orgId, q);
    await this.send(res, req, ctx, userId, "hours", hoursCsv(await this.hoursReports.hours(ctx)));
  }

  @Throttle(EXPORT_THROTTLE)
  @Get("revenue/export")
  async exportRevenue(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Query() q: ReportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = await this.contexts.resolve(orgId, q);
    await this.send(res, req, ctx, userId, "revenue", revenueCsv(await this.revenueReports.revenue(ctx)));
  }

  private async send(
    res: Response,
    req: Request,
    ctx: ReportContext,
    userId: string,
    report: string,
    csv: string,
  ): Promise<void> {
    const { from, to } = ctx.range;
    await this.audit.record({
      organizationId: ctx.orgId,
      actorId: userId,
      action: "report.exported",
      targetType: "report",
      targetId: report,
      summary: `Exported the ${report} report (${from} to ${to})`,
      metadata: { report, from, to, companyId: ctx.companyId },
      ...auditContext(req),
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", contentDisposition(`${report}-report-${from}-to-${to}.csv`));
    res.send(csv);
  }
}
