import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { resolveTxt } from "dns/promises";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, auditContext, type AuditRequestContext } from "../service-core";
import { publicApiUrl } from "../common/helpers/public-api-url";
import { SecretBox } from "./secret-box";
import {
  SsoConfigError,
  domainVerificationRecord,
  isPublicHttpsUrl,
  providerIdFor,
  validateSsoInput,
} from "./sso-config";
import type { SaveSsoProviderDto, UpdateSecuritySettingsDto } from "./security.dto";
import { TwoFactorEnforcementGuard } from "./two-factor.guard";
import { twoFactorRequiredFor } from "./two-factor-policy";

export interface SecurityActor {
  id: string;
  email?: string | null;
  twoFactorEnabled?: boolean | null;
}

type Discover = (params: { issuer: string; isTrustedOrigin: (url: string) => boolean }) => Promise<Record<string, unknown>>;
type TxtResolver = (name: string) => Promise<string[][]>;

/** Loaded lazily: the sso package is ESM and only needed when an owner saves a provider. */
const defaultDiscover: Discover = async (params) => {
  const mod = (await import("@better-auth/sso")) as unknown as { discoverOIDCConfig: Discover };
  return mod.discoverOIDCConfig(params);
};

@Injectable()
export class SecurityService {
  private readonly box: SecretBox;
  private readonly secret: string;
  /** Overridable in tests. */
  discover: Discover = defaultDiscover;
  resolveTxt: TxtResolver = resolveTxt;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private guard: TwoFactorEnforcementGuard,
    private config: ConfigService,
  ) {
    this.secret = this.config.getOrThrow<string>("BETTER_AUTH_SECRET");
    this.box = new SecretBox(this.secret);
  }

  ssoEnabled(): boolean {
    return this.config.get<string>("SSO_ENABLED") === "true";
  }

  // ── Two-factor ──

  async status(user: SecurityActor, organizationId: string | undefined, role: string | undefined) {
    const settings = organizationId ? await this.guard.settingsFor(organizationId) : null;
    const required = twoFactorRequiredFor(settings, role);
    const enabled = !!user.twoFactorEnabled;
    return {
      enabled,
      required,
      mustEnroll: required && !enabled,
      scope: settings?.twoFactorScope ?? "staff",
      ssoEnabled: this.ssoEnabled(),
    };
  }

  async getSettings(organizationId: string) {
    const row = await this.prisma.serviceSettings.findUnique({
      where: { organizationId },
      select: { requireTwoFactor: true, twoFactorScope: true },
    });
    return { requireTwoFactor: row?.requireTwoFactor ?? false, twoFactorScope: row?.twoFactorScope ?? "staff" };
  }

  async updateSettings(organizationId: string, dto: UpdateSecuritySettingsDto, actor: SecurityActor, req?: AuditRequestContext) {
    const current = await this.getSettings(organizationId);
    const next = {
      requireTwoFactor: dto.requireTwoFactor ?? current.requireTwoFactor,
      twoFactorScope: dto.twoFactorScope ?? current.twoFactorScope,
    };
    // Turning enforcement on while unenrolled would lock the owner out of this very page.
    if (next.requireTwoFactor && !actor.twoFactorEnabled) {
      throw new BadRequestException("Turn on two-factor authentication for your own account first");
    }
    await this.prisma.serviceSettings.upsert({
      where: { organizationId },
      create: { organizationId, ...next },
      update: next,
    });
    this.guard.invalidate(organizationId);
    if (next.requireTwoFactor !== current.requireTwoFactor || next.twoFactorScope !== current.twoFactorScope) {
      await this.audit.record({
        organizationId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "security.two_factor_enforcement_changed",
        targetType: "workspace",
        targetId: organizationId,
        summary: next.requireTwoFactor
          ? `Required two-factor authentication for ${next.twoFactorScope === "all" ? "everyone" : "staff"}`
          : "Stopped requiring two-factor authentication",
        metadata: { before: current, after: next },
        ...auditContext(req),
      });
    }
    return next;
  }

  // ── SSO (OIDC) ──

  private assertSsoEnabled(): void {
    if (!this.ssoEnabled()) throw new NotFoundException("Single sign-on is not enabled on this server");
  }

  private verificationToken(organizationId: string, domain: string): string {
    return createHmac("sha256", this.secret).update(`sso-domain:${organizationId}:${domain}`).digest("base64url").slice(0, 32);
  }

  async getSso(organizationId: string) {
    if (!this.ssoEnabled()) return { enabled: false, provider: null };
    const providerId = providerIdFor(organizationId);
    const row = await this.prisma.ssoProvider.findUnique({ where: { providerId } });
    const callbackUrl = `${publicApiUrl(this.config)}/api/auth/sso/callback/${providerId}`;
    if (!row) return { enabled: true, callbackUrl, provider: null };
    const config = JSON.parse(row.oidcConfig ?? "{}") as { clientId?: string; clientSecret?: string };
    return {
      enabled: true,
      callbackUrl,
      provider: {
        issuer: row.issuer,
        clientId: config.clientId ?? "",
        hasSecret: !!config.clientSecret,
        domain: row.domain,
        domainVerified: !!row.domainVerified,
        verificationRecord: domainVerificationRecord(row.domain, this.verificationToken(organizationId, row.domain)),
      },
    };
  }

  async saveSso(organizationId: string, dto: SaveSsoProviderDto, actor: SecurityActor, req?: AuditRequestContext) {
    this.assertSsoEnabled();
    const providerId = providerIdFor(organizationId);
    const existing = await this.prisma.ssoProvider.findUnique({ where: { providerId } });
    let valid;
    try {
      valid = validateSsoInput(dto, { requireSecret: !existing });
    } catch (err) {
      if (err instanceof SsoConfigError) throw new BadRequestException(err.message);
      throw err;
    }

    const clash = await this.prisma.ssoProvider.findFirst({
      where: { domain: valid.domain, providerId: { not: providerId } },
      select: { id: true },
    });
    if (clash) throw new BadRequestException("Another workspace already uses single sign-on for that domain");

    let discovered: Record<string, unknown>;
    try {
      discovered = await this.discover({ issuer: valid.issuer, isTrustedOrigin: isPublicHttpsUrl });
    } catch (err) {
      throw new BadRequestException(`Could not read the provider's OpenID configuration: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    for (const key of ["authorizationEndpoint", "tokenEndpoint", "jwksEndpoint"]) {
      const url = discovered[key];
      if (typeof url !== "string" || !isPublicHttpsUrl(url)) {
        throw new BadRequestException("The provider's OpenID configuration is missing a public https endpoint");
      }
    }

    const previous = existing?.oidcConfig ? (JSON.parse(existing.oidcConfig) as { clientSecret?: string }) : {};
    const sealedSecret = valid.clientSecret ? this.box.seal(valid.clientSecret) : previous.clientSecret;
    if (!sealedSecret) throw new BadRequestException("Enter the client secret from your identity provider");
    const oidcConfig = JSON.stringify({
      issuer: valid.issuer,
      clientId: valid.clientId,
      clientSecret: sealedSecret,
      pkce: true,
      discoveryEndpoint: discovered.discoveryEndpoint ?? `${valid.issuer}/.well-known/openid-configuration`,
      authorizationEndpoint: discovered.authorizationEndpoint,
      tokenEndpoint: discovered.tokenEndpoint,
      jwksEndpoint: discovered.jwksEndpoint,
      userInfoEndpoint: discovered.userInfoEndpoint,
      tokenEndpointAuthentication: discovered.tokenEndpointAuthentication,
      scopes: ["openid", "email", "profile"],
    });
    const domainChanged = !existing || existing.domain !== valid.domain;
    await this.prisma.ssoProvider.upsert({
      where: { providerId },
      create: {
        id: providerId,
        providerId,
        organizationId,
        userId: actor.id,
        issuer: valid.issuer,
        domain: valid.domain,
        domainVerified: false,
        oidcConfig,
      },
      update: {
        issuer: valid.issuer,
        domain: valid.domain,
        oidcConfig,
        ...(domainChanged ? { domainVerified: false } : {}),
      },
    });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: existing ? "security.sso_updated" : "security.sso_configured",
      targetType: "sso_provider",
      targetId: providerId,
      summary: `${existing ? "Updated" : "Configured"} single sign-on for ${valid.domain}`,
      metadata: { issuer: valid.issuer, domain: valid.domain, secretChanged: !!valid.clientSecret },
      ...auditContext(req),
    });
    return this.getSso(organizationId);
  }

  async verifySsoDomain(organizationId: string, actor: SecurityActor, req?: AuditRequestContext) {
    this.assertSsoEnabled();
    const providerId = providerIdFor(organizationId);
    const row = await this.prisma.ssoProvider.findUnique({ where: { providerId } });
    if (!row) throw new NotFoundException("Single sign-on is not configured");
    const record = domainVerificationRecord(row.domain, this.verificationToken(organizationId, row.domain));
    let found = false;
    try {
      const answers = await this.resolveTxt(record.name);
      found = answers.some((chunks) => chunks.join("") === record.value);
    } catch {
      found = false;
    }
    if (!found) throw new BadRequestException(`No TXT record ${record.name} with the expected value was found yet`);
    await this.prisma.ssoProvider.update({ where: { providerId }, data: { domainVerified: true } });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "security.sso_domain_verified",
      targetType: "sso_provider",
      targetId: providerId,
      summary: `Verified ${row.domain} for single sign-on`,
      ...auditContext(req),
    });
    return this.getSso(organizationId);
  }

  async deleteSso(organizationId: string, actor: SecurityActor, req?: AuditRequestContext) {
    this.assertSsoEnabled();
    const providerId = providerIdFor(organizationId);
    const row = await this.prisma.ssoProvider.findUnique({ where: { providerId } });
    if (!row) throw new NotFoundException("Single sign-on is not configured");
    await this.prisma.ssoProvider.delete({ where: { providerId } });
    await this.audit.record({
      organizationId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "security.sso_removed",
      targetType: "sso_provider",
      targetId: providerId,
      summary: `Removed single sign-on for ${row.domain}`,
      ...auditContext(req),
    });
  }

  /** Owners only; the controller's role check covers admins reading. */
  assertOwner(role: string | undefined): void {
    if (role !== "owner") throw new ForbiddenException("Only the workspace owner can change security settings");
  }
}
