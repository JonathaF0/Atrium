import { describe, expect, it, mock } from "bun:test";
import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { TwoFactorEnforcementGuard } from "./two-factor.guard";
import { isEnforcementExempt, twoFactorRequiredFor } from "./two-factor-policy";
import type { PrismaService } from "../prisma/prisma.service";

function contextFor(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function guardWith(settings: { requireTwoFactor: boolean; twoFactorScope: string } | null) {
  const findUnique = mock(() => Promise.resolve(settings));
  const guard = new TwoFactorEnforcementGuard({ serviceSettings: { findUnique } } as unknown as PrismaService);
  return { guard, findUnique };
}

const staffReq = (overrides: Record<string, unknown> = {}) => ({
  originalUrl: "/api/projects",
  user: { id: "u1", twoFactorEnabled: false },
  organization: { id: "org-1" },
  member: { role: "admin" },
  ...overrides,
});

describe("twoFactorRequiredFor", () => {
  it("applies the staff scope to owners and admins only", () => {
    const s = { requireTwoFactor: true, twoFactorScope: "staff" };
    expect(twoFactorRequiredFor(s, "owner")).toBe(true);
    expect(twoFactorRequiredFor(s, "admin")).toBe(true);
    expect(twoFactorRequiredFor(s, "member")).toBe(false);
    expect(twoFactorRequiredFor({ ...s, twoFactorScope: "all" }, "member")).toBe(true);
    expect(twoFactorRequiredFor({ ...s, requireTwoFactor: false }, "owner")).toBe(false);
    expect(twoFactorRequiredFor(null, "owner")).toBe(false);
  });
});

describe("isEnforcementExempt", () => {
  it("keeps sign-in, 2FA setup and the app shell reachable", () => {
    for (const path of ["/api/auth/two-factor/enable", "/api/auth/sign-out", "/api/security/two-factor/status", "/api/account/password", "/api/account", "/api/organization/current", "/api/health"]) {
      expect(isEnforcementExempt(path)).toBe(true);
    }
  });

  it("blocks everything else, including look-alike prefixes", () => {
    for (const path of ["/api/projects", "/api/invoices/mine", "/api/accounts-export", "/api/organization/other", "/api/settings"]) {
      expect(isEnforcementExempt(path)).toBe(false);
    }
  });
});

describe("TwoFactorEnforcementGuard", () => {
  it("refuses an unenrolled admin with TWO_FACTOR_REQUIRED when staff must enrol", async () => {
    const { guard } = guardWith({ requireTwoFactor: true, twoFactorScope: "staff" });
    try {
      await guard.canActivate(contextFor(staffReq()));
      throw new Error("expected a 403");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ error: "TWO_FACTOR_REQUIRED" });
    }
  });

  it("lets enrolled users, exempt routes, clients under the staff scope and API keys through", async () => {
    const { guard } = guardWith({ requireTwoFactor: true, twoFactorScope: "staff" });
    expect(await guard.canActivate(contextFor(staffReq({ user: { id: "u1", twoFactorEnabled: true } })))).toBe(true);
    expect(await guard.canActivate(contextFor(staffReq({ originalUrl: "/api/auth/two-factor/enable" })))).toBe(true);
    expect(await guard.canActivate(contextFor(staffReq({ member: { role: "member" } })))).toBe(true);
    expect(await guard.canActivate(contextFor(staffReq({ bearerKind: "apiKey" })))).toBe(true);
    expect(await guard.canActivate(contextFor({ originalUrl: "/api/projects" }))).toBe(true);
  });

  it("applies to clients when everyone must enrol", async () => {
    const { guard } = guardWith({ requireTwoFactor: true, twoFactorScope: "all" });
    await expect(guard.canActivate(contextFor(staffReq({ member: { role: "member" } })))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("does nothing when the workspace does not require it", async () => {
    const { guard } = guardWith({ requireTwoFactor: false, twoFactorScope: "all" });
    expect(await guard.canActivate(contextFor(staffReq()))).toBe(true);
  });

  it("caches the setting per workspace until invalidated", async () => {
    const { guard, findUnique } = guardWith(null);
    await guard.canActivate(contextFor(staffReq()));
    await guard.canActivate(contextFor(staffReq()));
    expect(findUnique).toHaveBeenCalledTimes(1);
    guard.invalidate("org-1");
    await guard.canActivate(contextFor(staffReq()));
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
