import { BadRequestException } from "@nestjs/common";

/**
 * Client documentation must never hold secrets; they belong in a password
 * vault, linked from the doc's vault URL. This catches the obvious cases
 * (a labelled secret followed by a value, private keys, credentials embedded
 * in URLs) so they're rejected with a clear message instead of being stored.
 */

// "password: hunter2", "pwd=abc", "API key - xyz", "secret := value"
const LABELLED_SECRET =
  /\b(passwords?|passwd|pwd|pass ?phrase|passcode|pin ?code|secret|client[ _-]?secret|api[ _-]?key|access[ _-]?key|auth[ _-]?token|token)\b\s*(?::=|[:=]|\s-\s)\s*(\S+)/gi;

// Values that point elsewhere rather than being the secret itself.
const PLACEHOLDER =
  /^(?:[<([{*]|\.{3}|…|see\b|in\b|stored\b|vault\b|n\/a$|na$|none$|redacted|removed|hidden|ask\b|tbd$|-+$|\[?link\]?)/i;

const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
// scheme://user:password@host
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;

export interface CredentialFinding {
  kind: "labelled" | "private_key" | "url_credentials";
  label?: string;
}

export function findCredential(text: string): CredentialFinding | null {
  if (!text) return null;
  if (PRIVATE_KEY.test(text)) return { kind: "private_key" };
  if (URL_CREDENTIALS.test(text)) return { kind: "url_credentials" };
  for (const match of text.matchAll(LABELLED_SECRET)) {
    const value: string = match[2].replace(/^["'`]|["'`.,;]$/g, "");
    if (!value || PLACEHOLDER.test(value)) continue;
    return { kind: "labelled", label: match[1].toLowerCase() };
  }
  return null;
}

export function assertNoCredentials(...texts: Array<string | null | undefined>): void {
  for (const text of texts) {
    const finding = text ? findCredential(text) : null;
    if (!finding) continue;
    const what: string =
      finding.kind === "private_key"
        ? "a private key"
        : finding.kind === "url_credentials"
          ? "a URL with a username and password"
          : `a ${finding.label}`;
    throw new BadRequestException(
      `This looks like it contains ${what}. Client documentation must not store secrets: keep them in your password vault and add the vault link instead.`,
    );
  }
}
