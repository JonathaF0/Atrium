import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { assertNoCredentials, findCredential } from "./credential-guard";

describe("findCredential", () => {
  const rejected: string[] = [
    "Admin password: Summer2026!",
    "password:hunter2",
    "Router pwd=abc123",
    "PASSWORD = s3cret",
    "wifi passphrase: correct-horse",
    "API key: sk_live_0000",
    "api_key=abcd",
    "client secret := xyz",
    "token: eyJhbGciOi",
    "Passwords - letmein",
    "Backup NAS at smb://backup:Secret99@nas.example.com/share",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
  ];
  for (const text of rejected) {
    it(`rejects ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(findCredential(text)).not.toBeNull();
    });
  }

  const allowed: string[] = [
    "Password: see vault",
    "password: (in the vault)",
    "Password: <stored in vault>",
    "pwd = *****",
    "Password: n/a",
    "Admin password is rotated quarterly.",
    "Reset the password from the admin console.",
    "Use password managers for all accounts.",
    "Firewall: 10.0.0.1, VLAN 20 for VoIP",
    "Portal: https://portal.example.com/login",
    "The token expires after 30 days.",
    "",
  ];
  for (const text of allowed) {
    it(`allows ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(findCredential(text)).toBeNull();
    });
  }

  it("reports what it found", () => {
    expect(findCredential("PWD=abc")).toEqual({ kind: "labelled", label: "pwd" });
    expect(findCredential("ftp://u:p@host")).toEqual({ kind: "url_credentials" });
  });
});

describe("assertNoCredentials", () => {
  it("throws a clear 400 that points at the vault", () => {
    try {
      assertNoCredentials("Notes", "Switch password: admin123");
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toContain("a password");
      expect((err as Error).message).toContain("vault");
    }
  });

  it("ignores empty values", () => {
    expect(() => assertNoCredentials(undefined, null, "", "Plain notes")).not.toThrow();
  });
});
