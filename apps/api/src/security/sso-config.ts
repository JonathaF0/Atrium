import { isIP } from "net";

/** Consumer mail domains: anyone can hold an address there, so none may route to a workspace IdP. */
const SHARED_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
]);

const DOMAIN_PATTERN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface SsoInput {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  domain: string;
}

export interface ValidSsoConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  domain: string;
}

export class SsoConfigError extends Error {}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host === "::";
  return !host.includes(".");
}

/** An https URL on a public host, as the issuer and every discovered endpoint must be. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && !isPrivateHost(url.hostname);
}

export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
}

/** The address's domain, lowercased; null when it is not an email address. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = normalizeDomain(email.slice(at + 1));
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

/**
 * Validates an owner's OIDC provider settings. The issuer must be a public
 * https URL (it is fetched server-side), and the domain a real organisational
 * domain rather than a shared mailbox provider.
 */
export function validateSsoInput(input: SsoInput, opts: { requireSecret: boolean }): ValidSsoConfig {
  const issuer = input.issuer.trim().replace(/\/+$/, "");
  if (!isPublicHttpsUrl(issuer)) throw new SsoConfigError("The issuer must be a public https URL");
  if (new URL(issuer).search || new URL(issuer).hash) throw new SsoConfigError("The issuer must not contain a query or fragment");

  const clientId = input.clientId.trim();
  if (!clientId || clientId.length > 255 || /\s/.test(clientId)) throw new SsoConfigError("Enter the client ID from your identity provider");

  const clientSecret = input.clientSecret?.trim() || undefined;
  if (opts.requireSecret && !clientSecret) throw new SsoConfigError("Enter the client secret from your identity provider");
  if (clientSecret && clientSecret.length > 1024) throw new SsoConfigError("The client secret is too long");

  const domain = normalizeDomain(input.domain);
  if (!DOMAIN_PATTERN.test(domain)) throw new SsoConfigError("Enter your email domain, like example.com");
  if (SHARED_MAIL_DOMAINS.has(domain)) throw new SsoConfigError("A shared email provider's domain cannot be used for single sign-on");

  return { issuer, clientId, clientSecret, domain };
}

/** The provider id Better Auth routes callbacks by; one OIDC provider per workspace. */
export function providerIdFor(organizationId: string): string {
  return `ws-${organizationId}`;
}

/** DNS TXT record name and value an owner publishes to prove they control the domain. */
export function domainVerificationRecord(domain: string, token: string): { name: string; value: string } {
  return { name: `_atrium-sso.${domain}`, value: `atrium-sso-verification=${token}` };
}
