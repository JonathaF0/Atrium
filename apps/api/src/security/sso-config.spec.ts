import { describe, expect, it, mock } from "bun:test";
import { SecretBox } from "./secret-box";
import { openOidcConfig } from "./sso-prisma";
import { SsoConfigError, emailDomain, isPublicHttpsUrl, validateSsoInput } from "./sso-config";
import { callbackProviderId, ssoAccessAllowed, ssoSignUpAllowed } from "./auth-security.plugin";
import { totpAt, verifyTotp } from "./totp";
import type { PrismaService } from "../prisma/prisma.service";

const valid = { issuer: "https://login.example.com/", clientId: "atrium-client", clientSecret: "s3cret", domain: "Example.COM" };

describe("validateSsoInput", () => {
  it("normalises a valid OIDC configuration", () => {
    expect(validateSsoInput(valid, { requireSecret: true })).toEqual({
      issuer: "https://login.example.com",
      clientId: "atrium-client",
      clientSecret: "s3cret",
      domain: "example.com",
    });
  });

  it("rejects issuers that are not public https URLs", () => {
    for (const issuer of ["http://login.example.com", "https://localhost:8443", "https://10.0.0.5", "https://user:pw@login.example.com", "https://idp.internal", "not a url", "https://login.example.com/?x=1"]) {
      expect(() => validateSsoInput({ ...valid, issuer }, { requireSecret: true })).toThrow(SsoConfigError);
    }
  });

  it("rejects shared mailbox domains and malformed domains", () => {
    for (const domain of ["gmail.com", "outlook.com", "localhost", "example", "-bad.example.com"]) {
      expect(() => validateSsoInput({ ...valid, domain }, { requireSecret: true })).toThrow(SsoConfigError);
    }
  });

  it("requires a secret only when none is stored yet", () => {
    expect(() => validateSsoInput({ ...valid, clientSecret: "" }, { requireSecret: true })).toThrow(SsoConfigError);
    expect(validateSsoInput({ ...valid, clientSecret: "" }, { requireSecret: false }).clientSecret).toBeUndefined();
  });

  it("parses email domains and public URLs", () => {
    expect(emailDomain("Someone@Sub.Example.com")).toBe("sub.example.com");
    expect(emailDomain("nobody")).toBeNull();
    expect(isPublicHttpsUrl("https://login.example.com/oauth2/token")).toBe(true);
    expect(isPublicHttpsUrl("https://192.168.1.10/token")).toBe(false);
  });
});

describe("SSO secret sealing", () => {
  const box = new SecretBox("x".repeat(32));

  it("round-trips and refuses a value sealed with another key", () => {
    const sealed = box.seal("client-secret");
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain("client-secret");
    expect(box.open(sealed)).toBe("client-secret");
    expect(new SecretBox("y".repeat(32)).open(sealed)).toBeNull();
  });

  it("unseals only the clientSecret inside a stored oidcConfig", () => {
    const stored = JSON.stringify({ clientId: "abc", clientSecret: box.seal("client-secret") });
    expect(JSON.parse(openOidcConfig(stored, box) as string)).toEqual({ clientId: "abc", clientSecret: "client-secret" });
    expect(openOidcConfig(null, box)).toBeNull();
  });
});

describe("SSO access gates", () => {
  function prismaWith(opts: { member?: boolean; invitation?: boolean; provider?: { organizationId: string } | null }) {
    return {
      member: { findFirst: mock(() => Promise.resolve(opts.member ? { id: "m1" } : null)) },
      invitation: { findFirst: mock(() => Promise.resolve(opts.invitation ? { id: "i1" } : null)) },
      ssoProvider: { findUnique: mock(() => Promise.resolve(opts.provider ?? null)) },
    } as unknown as PrismaService;
  }

  it("lets members and invitees of the provider's workspace in", async () => {
    expect(await ssoAccessAllowed(prismaWith({ member: true }), "org-1", "u1", "a@example.com")).toBe(true);
    expect(await ssoAccessAllowed(prismaWith({ invitation: true }), "org-1", "u1", "a@example.com")).toBe(true);
    expect(await ssoAccessAllowed(prismaWith({}), "org-1", "u1", "a@example.com")).toBe(false);
  });

  it("only creates SSO accounts for invited people, and leaves other routes alone", async () => {
    const provider = { organizationId: "org-1" };
    const ctx = { path: "/sso/callback/:providerId", params: { providerId: "ws-org-1" } };
    expect(await ssoSignUpAllowed(prismaWith({ provider, invitation: true }), "a@example.com", ctx)).toBe(true);
    expect(await ssoSignUpAllowed(prismaWith({ provider, invitation: false }), "a@example.com", ctx)).toBe(false);
    expect(await ssoSignUpAllowed(prismaWith({ provider: null }), "a@example.com", ctx)).toBe(false);
    expect(await ssoSignUpAllowed(prismaWith({}), "a@example.com", { path: "/sign-up/email" })).toBe(true);
  });

  it("reads the provider id from the callback URL", () => {
    expect(callbackProviderId(new Request("https://api.example.com/api/auth/sso/callback/ws-org-1?code=x"))).toBe("ws-org-1");
    expect(callbackProviderId(new Request("https://api.example.com/api/auth/sso/callback"))).toBeUndefined();
  });
});

describe("TOTP", () => {
  it("matches the RFC 6238 test vector and accepts one step of drift", () => {
    const key = Buffer.from("12345678901234567890");
    // RFC 6238, SHA-1, T = 59 s -> 94287082 (8 digits); the last 6 digits are the 6-digit code.
    expect(totpAt(key, 59_000)).toBe("287082");
    const now = 1_700_000_000_000;
    expect(verifyTotp(totpAt(key, now - 30_000), key, now)).toBe(true);
    expect(verifyTotp(totpAt(key, now - 90_000), key, now)).toBe(false);
    expect(verifyTotp("abc123", key, now)).toBe(false);
  });
});
