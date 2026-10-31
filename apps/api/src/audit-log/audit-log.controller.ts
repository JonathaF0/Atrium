import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard, CurrentOrg, Roles, RolesGuard, contentDisposition, toCsv } from "../common";
import type { CsvColumn } from "../common";
import { AuditLogService } from "./audit-log.service";
import { AuditLogQueryDto } from "./audit-log.dto";
import { Audited } from "./audited.decorator";

@Controller("audit-log")
@UseGuards(AuthGuard, RolesGuard)
@Roles("owner", "admin")
export class AuditLogController {
  constructor(private auditLog: AuditLogService) {}

  @Get()
  list(@CurrentOrg("id") orgId: string, @Query() query: AuditLogQueryDto): Promise<unknown> {
    return this.auditLog.list(orgId, query);
  }

  @Get("actors")
  actors(@CurrentOrg("id") orgId: string) {
    return this.auditLog.actors(orgId);
  }

  @Get("export")
  @Audited({
    action: "export.audit_log",
    targetType: "export",
    targetId: () => null,
    summary: "Exported the audit log as CSV",
    metadata: (req) => ({ filters: req.query }),
  })
  async export(@CurrentOrg("id") orgId: string, @Query() query: AuditLogQueryDto, @Res() res: Response) {
    const rows = await this.auditLog.exportRows(orgId, query);
    const columns: CsvColumn<(typeof rows)[0]>[] = [
      { header: "Time (UTC)", value: (r) => r.createdAt.toISOString() },
      { header: "Action", value: (r) => r.action },
      { header: "Actor", value: (r) => r.actorEmail ?? r.actorId ?? "system" },
      { header: "Target Type", value: (r) => r.targetType },
      { header: "Target ID", value: (r) => r.targetId },
      { header: "Summary", value: (r) => r.summary },
      { header: "IP Address", value: (r) => r.ipAddress },
      { header: "User Agent", value: (r) => r.userAgent },
      { header: "Details", value: (r) => (r.metadata ? JSON.stringify(r.metadata) : "") },
    ];
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", contentDisposition("audit-log.csv"));
    res.send(toCsv(columns, rows));
  }
}
