import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthGuard, CurrentOrg, Roles, RolesGuard } from "../common";
import type { AuthenticatedRequest } from "../common";
import { ClientInvitesService } from "./client-invites.service";
import type { InviteResult } from "./client-invites.service";
import { InviteClientDto } from "./client-invites.dto";

/**
 * Portal invitations from outside systems (a CRM workflow, a script). Meant for
 * API keys, but a signed-in owner or admin can call it too.
 */
@Controller("clients/invite")
@UseGuards(AuthGuard, RolesGuard)
export class ClientInvitesController {
  constructor(private invites: ClientInvitesService) {}

  @Post()
  @HttpCode(200)
  @Roles("owner", "admin")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  invite(
    @CurrentOrg("id") orgId: string,
    @Body() dto: InviteClientDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<InviteResult> {
    return this.invites.invite(
      orgId,
      { userId: req.user.id, name: req.user.name, email: req.user.email, apiKeyId: req.apiKeyId },
      dto,
      req,
    );
  }
}
