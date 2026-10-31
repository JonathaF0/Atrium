import { describe, expect, it, mock } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { SecurityService } from "./security.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../service-core";
import type { TwoFactorEnforcementGuard } from "./two-factor.guard";

type Row = Record<string, unknown> | null;

function setup(opts: { sso?: boolean; provider?: Row; clash?: Row; settings?: Row } = {}) {
  let provider: Row = opts.provider ?? null;
  const prisma = {
    serviceSettings: {
      findUnique: mock(() => Promise.resolve(opts.settings ?? null)),
      upsert: mock(() => Promise.resolve({})),
    },
    ssoProvider: {
      findUnique: mock(() => Promise.resolve(provider)),
      findFirst: mock(() => Promise.resolve(opts.clash ?? null)),
      upsert: mock((args: { create: Record<string, unknown> }) => {
        provider = { ...args.create };
        return Promise.resolve(provider);
      }),
      update: mock((args: { data: Record<string, unknown> }) => {
        provider = { ...provider, ...args.data };
        return Promise.resolve(provider);
      }),
      delete: mock(() => Promise.resolve()),
    },
  };
  const audit = { record: mock(() => Promise.resolve()) };
  const guard = { invalidate: mock(() => undefined), settingsFor: mock(() => Promise.resolve(null)) };
  const config = {
    get: (key: string, fallback?: string) => (key === "SSO_ENABLED" ? (opts.sso ? "true" : undefined) : fallback),
    getOrThrow: () => "x".repeat(32),
  };
  const service = new SecurityService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    guard as unknown as TwoFactorEnforcementGuard,
    config as unknown as ConfigService,
  );
  service.discover = mock(() =>
    Promise.resolve({
      authorizationEndpoint: "https://login.example.com/authorize",
      tokenEndpoint: "https://login.example.com/token",
      jwksEndpoint: "https://login.example.com/jwks",
      discoveryEndpoint: "https://login.example.com/.well-known/openid-configuration",
    }),
  );
  return { service, prisma, audit, guard, current: () => provider };
}

const owner = { id: "owner-1", email: "owner@example.com", twoFactorEnabled: true };

describe("SecurityService two-factor settings", () => {
  it("refuses to require 2FA until the owner has it", async () => {
    const { service } = setup();
    await expect(service.updateSettings("org-1", { requireTwoFactor: true }, { ...owner, twoFactorEnabled: false })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("saves, clears the guard cache and audits a change", async () => {
    const { service, prisma, guard, audit } = setup();
    expect(await service.updateSettings("org-1", { requireTwoFactor: true, twoFactorScope: "all" }, owner)).toEqual({ requireTwoFactor: true, twoFactorScope: "all" });
    expect(prisma.serviceSettings.upsert).toHaveBeenCalled();
    expect(guard.invalidate).toHaveBeenCalledWith("org-1");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "security.two_factor_enforcement_changed" }));
  });
});

describe("SecurityService SSO", () => {
  const dto = { issuer: "https://login.example.com", clientId: "client", clientSecret: "secret", domain: "example.com" };

  it("is unavailable unless SSO_ENABLED=true", async () => {
    const { service } = setup({ sso: false });
    expect(await service.getSso("org-1")).toEqual({ enabled: false, provider: null });
    await expect(service.saveSso("org-1", dto, owner)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("stores the secret sealed, never in plain text, and starts unverified", async () => {
    const { service, current, audit } = setup({ sso: true });
    const result = await service.saveSso("org-1", dto, owner);
    const stored = current() as { oidcConfig: string; domainVerified: boolean; providerId: string; organizationId: string };
    expect(stored.oidcConfig).not.toContain("secret\"");
    expect(JSON.parse(stored.oidcConfig).clientSecret).toMatch(/^enc:v1:/);
    expect(stored.domainVerified).toBe(false);
    expect(stored.providerId).toBe("ws-org-1");
    expect(stored.organizationId).toBe("org-1");
    expect(result.provider).toMatchObject({ domain: "example.com", hasSecret: true, domainVerified: false });
    expect(JSON.stringify(result)).not.toContain("enc:v1:");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "security.sso_configured" }));
  });

  it("refuses a domain another workspace already uses", async () => {
    const { service } = setup({ sso: true, clash: { id: "other" } });
    await expect(service.saveSso("org-1", dto, owner)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses discovery documents with private endpoints", async () => {
    const { service } = setup({ sso: true });
    service.discover = mock(() =>
      Promise.resolve({ authorizationEndpoint: "https://login.example.com/a", tokenEndpoint: "https://127.0.0.1/token", jwksEndpoint: "https://login.example.com/j" }),
    );
    await expect(service.saveSso("org-1", dto, owner)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("verifies the domain only when the TXT record matches", async () => {
    const { service, current } = setup({ sso: true });
    await service.saveSso("org-1", dto, owner);
    const sso = await service.getSso("org-1");
    const record = sso.provider!.verificationRecord;

    service.resolveTxt = mock(() => Promise.resolve([["unrelated"]]));
    await expect(service.verifySsoDomain("org-1", owner)).rejects.toBeInstanceOf(BadRequestException);
    expect((current() as { domainVerified: boolean }).domainVerified).toBe(false);

    service.resolveTxt = mock((name: string) => Promise.resolve(name === record.name ? [[record.value]] : []));
    const verified = await service.verifySsoDomain("org-1", owner);
    expect(verified.provider?.domainVerified).toBe(true);
  });
});
