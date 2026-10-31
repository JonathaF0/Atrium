import { Body, Controller, Delete, Get, HttpCode, Post, Put, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { AuthGuard, CurrentMember, CurrentOrg, CurrentUser, Public, Roles, RolesGuard } from "../common";
import type { AuthUser } from "../common";
import { SecurityService } from "./security.service";
import { SaveSsoProviderDto, UpdateSecuritySettingsDto } from "./security.dto";

type UserWith2fa = AuthUser & { twoFactorEnabled?: boolean | null };

@Controller("security")
@UseGuards(AuthGuard, RolesGuard)
export class SecurityController {
  constructor(private security: SecurityService) {}

  /** Whether the signed-in user must enrol before using the workspace; the web app redirects on it. */
  @Get("two-factor/status")
  status(@CurrentUser() user: UserWith2fa, @CurrentOrg("id") orgId?: string, @CurrentMember("role") role?: string) {
    return this.security.status(user, orgId, role);
  }

  @Get("settings")
  @Roles("owner", "admin")
  getSettings(@CurrentOrg("id") orgId: string) {
    return this.security.getSettings(orgId);
  }

  @Put("settings")
  @Roles("owner")
  updateSettings(
    @CurrentOrg("id") orgId: string,
    @Body() dto: UpdateSecuritySettingsDto,
    @CurrentUser() user: UserWith2fa,
    @Req() req: Request,
  ) {
    return this.security.updateSettings(orgId, dto, user, req);
  }

  @Get("sso")
  @Roles("owner", "admin")
  getSso(@CurrentOrg("id") orgId: string) {
    return this.security.getSso(orgId);
  }

  @Put("sso")
  @Roles("owner")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  saveSso(@CurrentOrg("id") orgId: string, @Body() dto: SaveSsoProviderDto, @CurrentUser() user: UserWith2fa, @Req() req: Request) {
    return this.security.saveSso(orgId, dto, user, req);
  }

  @Post("sso/verify-domain")
  @HttpCode(200)
  @Roles("owner")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  verifySsoDomain(@CurrentOrg("id") orgId: string, @CurrentUser() user: UserWith2fa, @Req() req: Request) {
    return this.security.verifySsoDomain(orgId, user, req);
  }

  @Delete("sso")
  @Roles("owner")
  deleteSso(@CurrentOrg("id") orgId: string, @CurrentUser() user: UserWith2fa, @Req() req: Request) {
    return this.security.deleteSso(orgId, user, req);
  }
}

/** What the login page needs to know before anyone is signed in. */
@Controller("security/sign-in")
@Public()
export class SecuritySignInController {
  constructor(private security: SecurityService) {}

  @Get("options")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  options() {
    return { sso: this.security.ssoEnabled() };
  }
}
