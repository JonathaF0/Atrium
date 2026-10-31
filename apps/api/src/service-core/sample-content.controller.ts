import { Controller, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { seedSampleContent } from "@atrium/database";
import { AuthGuard, CurrentOrg, CurrentUser, Roles, RolesGuard } from "../common";
import type { AuthenticatedRequest } from "../common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, auditContext } from "./audit.service";

@Controller("service-settings")
@UseGuards(AuthGuard, RolesGuard)
export class SampleContentController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** Loads the generic sample catalog, KB drafts, canned responses and templates. Idempotent. */
  @Post("sample-content")
  @Roles("owner")
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async loadSampleContent(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await seedSampleContent(this.prisma, orgId);
    await this.audit.record({
      organizationId: orgId,
      actorId: userId,
      action: "workspace.sample_content_loaded",
      targetType: "organization",
      targetId: orgId,
      metadata: result.created,
      ...auditContext(req),
    });
    return result;
  }
}
