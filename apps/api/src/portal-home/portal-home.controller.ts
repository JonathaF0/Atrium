import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthGuard, CurrentMember, CurrentOrg, CurrentUser, RolesGuard } from "../common";
import { PortalHomeService, type PortalHome } from "./portal-home.service";

/** The portal landing page. Scope comes from the session only; nothing is taken from the client. */
@Controller("portal-home")
@UseGuards(AuthGuard, RolesGuard)
export class PortalHomeController {
  constructor(private home: PortalHomeService) {}

  @Get("mine")
  mine(
    @CurrentUser("id") userId: string,
    @CurrentOrg("id") orgId: string,
    @CurrentMember("role") role?: string,
  ): Promise<PortalHome> {
    return this.home.get(userId, orgId, role);
  }
}
