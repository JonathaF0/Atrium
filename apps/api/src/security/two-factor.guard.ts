import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import type { EnforcementSettings } from "./two-factor-policy";
import { TWO_FACTOR_REQUIRED_CODE, isEnforcementExempt, twoFactorRequiredFor } from "./two-factor-policy";

const CACHE_TTL_MS = 30_000;

type GuardRequest = Request & {
  user?: { id: string; twoFactorEnabled?: boolean | null };
  organization?: { id: string };
  member?: { role: string };
  bearerKind?: string;
  previewMode?: boolean;
};

/**
 * Global guard: while a workspace requires two-factor authentication, a
 * signed-in user it applies to who has not enrolled gets 403
 * TWO_FACTOR_REQUIRED from everything except the routes needed to enrol.
 * API keys and MCP tokens are not sessions and are left alone.
 */
@Injectable()
export class TwoFactorEnforcementGuard implements CanActivate {
  private cache = new Map<string, { value: EnforcementSettings | null; expiresAt: number }>();

  constructor(private prisma: PrismaService) {}

  /** Drops a workspace's cached setting after it changes. */
  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  async settingsFor(organizationId: string): Promise<EnforcementSettings | null> {
    const hit = this.cache.get(organizationId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await this.prisma.serviceSettings.findUnique({
      where: { organizationId },
      select: { requireTwoFactor: true, twoFactorScope: true },
    });
    this.cache.set(organizationId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    if (this.cache.size > 5000) this.cache.clear();
    return value;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const req = context.switchToHttp().getRequest<GuardRequest>();
    if (!req.user || !req.organization || !req.member || req.bearerKind || req.previewMode) return true;
    if (req.user.twoFactorEnabled) return true;
    if (isEnforcementExempt(req.originalUrl ?? req.url)) return true;
    const settings = await this.settingsFor(req.organization.id);
    if (!twoFactorRequiredFor(settings, req.member.role)) return true;
    throw new ForbiddenException({
      statusCode: 403,
      error: TWO_FACTOR_REQUIRED_CODE,
      message: "This workspace requires two-factor authentication. Set it up to continue.",
    });
  }
}
