import { createHmac, timingSafeEqual } from "crypto";

/** A received email after parsing, whatever transport it came from. */
export interface ParsedEmail {
  messageId: string;
  fromEmail: string;
  fromName: string | null;
  to: string[];
  subject: string;
  text: string;
  inReplyTo: string | null;
  references: string[];
  headers: Record<string, string>;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

export const SIGNATURE_HEADER = "x-atrium-signature";
export const TIMESTAMP_HEADER = "x-atrium-timestamp";
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** HMAC-SHA256 of `${timestamp}.${rawBody}`, hex encoded. */
export function signPayload(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

/**
 * Verifies `X-Atrium-Signature: sha256=<hex>` over the raw body. The timestamp
 * (unix seconds) is part of the signed data and must be within five minutes,
 * so a captured request cannot be replayed later.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!secret || !signatureHeader || !timestampHeader) return false;
  if (!/^\d{9,11}$/.test(timestampHeader)) return false;
  const ts: number = Number(timestampHeader);
  if (Math.abs(now.getTime() / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected: Buffer = Buffer.from(signPayload(secret, timestampHeader, rawBody), "hex");
  const given: Buffer = Buffer.from(match[1].toLowerCase(), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Extracts `addr@host` from `"Name" <addr@host>` and lowercases it. */
export function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = /<([^>]+)>/.exec(value);
  const addr: string = (angle ? angle[1] : value).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr) ? addr : null;
}

export function displayName(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^\s*"?([^"<]*?)"?\s*</.exec(value);
  const name: string = (m?.[1] ?? "").trim();
  return name.length > 0 ? name.slice(0, 200) : null;
}

/** Message ids from a References / In-Reply-To header, without angle brackets. */
export function parseMessageIds(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  const joined: string = Array.isArray(value) ? value.join(" ") : value;
  const ids: string[] = [];
  for (const m of joined.matchAll(/<([^<>\s]+)>/g)) ids.push(m[1]);
  if (ids.length === 0 && joined.trim() && !/\s/.test(joined.trim())) ids.push(joined.trim());
  return ids.slice(0, 50);
}

export function stripAngles(id: string): string {
  return id.trim().replace(/^<|>$/g, "");
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Finds the ticket token. Outgoing mail carries it as `[PREFIX-1042:token]`
 * (in the body footer, and in subjects of mail from other tools) and as a
 * plus-address on Reply-To (`support+token@example.com`). The number alone is
 * never trusted: it is guessable, the token is not.
 */
export function findTicketToken(email: Pick<ParsedEmail, "subject" | "text" | "to">, prefix: string): string | null {
  const escaped: string = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[${escaped}-\\d+:([A-Za-z0-9_-]{16,64})\\]`, "i");
  const fromSubject = re.exec(email.subject);
  if (fromSubject) return fromSubject[1];
  for (const addr of email.to) {
    const local: string = addr.split("@")[0] ?? "";
    const plus: number = local.indexOf("+");
    if (plus !== -1) {
      const token: string = local.slice(plus + 1);
      if (TOKEN_RE.test(token)) return token;
    }
  }
  const fromBody = re.exec(email.text);
  return fromBody ? fromBody[1] : null;
}

/** Plus-address carrying the ticket token, or null when the inbound address can't take one. */
export function plusAddress(address: string | null | undefined, token: string): string | null {
  const addr: string | null = normalizeAddress(address);
  if (!addr) return null;
  const [local, domain] = addr.split("@");
  return `${local.split("+")[0]}+${token}@${domain}`;
}

const REPLY_MARKERS: RegExp[] = [
  /^\s*On\s.+wrote:\s*$/i, // Gmail, Apple Mail: "On Tue, Jan 2, 2026 at 10:00, Name <a@b> wrote:"
  /^\s*Le\s.+a écrit\s?:\s*$/i,
  /^\s*Am\s.+schrieb.+:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i, // Outlook
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/, // Outlook separator line
  /^\s*From:\s.+$/i, // Outlook header block ("From: ... / Sent: ...")
  /^\s*-{2,}\s*Reply above this line\s*-{2,}\s*$/i,
];

/**
 * Keeps only the new part of a reply: cuts at the first quote header
 * ("On ... wrote:", "-----Original Message-----", an Outlook "From:" block)
 * or at a trailing run of ">" quoted lines, and drops a "-- " signature.
 * Falls back to the whole text if stripping would leave nothing.
 */
export function stripQuotedReply(text: string): string {
  const lines: string[] = text.replace(/\r\n?/g, "\n").split("\n");
  let end: number = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i];
    if (REPLY_MARKERS.some((re) => re.test(line))) {
      // An Outlook "From:" only counts when a "Sent:"/"Date:" line follows it.
      if (/^\s*From:\s/i.test(line) && !/^\s*(Sent|Date):\s/i.test(lines[i + 1] ?? "")) continue;
      end = i;
      break;
    }
    // Gmail wraps long "On ... wrote:" headers over two lines.
    if (/^\s*On\s.+/i.test(line) && /wrote:\s*$/i.test(lines[i + 1] ?? "") && !/^\s*>/.test(lines[i + 1] ?? "")) {
      end = i;
      break;
    }
    if (line === "-- " || line === "--") {
      end = i;
      break;
    }
  }
  let kept: string[] = lines.slice(0, end);
  // Drop trailing quoted (">") and blank lines.
  while (kept.length > 0 && (/^\s*>/.test(kept[kept.length - 1]) || kept[kept.length - 1].trim() === "")) {
    kept = kept.slice(0, -1);
  }
  const result: string = kept.join("\n").trim();
  return result.length > 0 ? result : text.trim();
}

/** True for auto-replies, bounces and bulk mail, which must never open or update tickets. */
export function isAutomatedEmail(headers: Record<string, string>, fromEmail: string): boolean {
  const h = (name: string): string => (headers[name.toLowerCase()] ?? "").toLowerCase().trim();
  const autoSubmitted: string = h("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (["bulk", "junk", "list", "auto_reply"].includes(h("precedence"))) return true;
  if (h("x-autoreply") || h("x-autorespond") || h("x-auto-response-suppress").includes("all")) return true;
  if (h("list-id") || h("list-unsubscribe")) return true;
  if (h("content-type").startsWith("multipart/report")) return true;
  const local: string = fromEmail.split("@")[0] ?? "";
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)$/i.test(local);
}

/** Lowercased header map from any header-ish shape (object of strings or arrays). */
export function headerMap(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item && typeof item === "object" && "name" in item && "value" in item) {
        out[String((item as { name: unknown }).name).toLowerCase()] = String((item as { value: unknown }).value).slice(0, 2000);
      }
    }
    return out;
  }
  if (typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v == null) continue;
      out[k.toLowerCase()] = (Array.isArray(v) ? v.join(", ") : String(v)).slice(0, 2000);
    }
  }
  return out;
}

/** Very small HTML → text fallback for mail without a text part. Tags are dropped, never rendered. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
