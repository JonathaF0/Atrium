import { normalizeMarkdown } from "../service-core";

export interface TicketMessageInput {
  visibility: string;
  body: string;
  source: string;
  authorUserId: string | null;
  createdAt: Date;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-like runs: optional +, then 7+ digits with common separators.
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{6,}\d(?![\w.])/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// "Hi Sam," / "Thanks, Sam" style greetings and sign-offs that name a person.
const GREETING = /^(hi|hello|hey|dear)\b[^\n]{0,40},?\s*$/gim;
const SIGN_OFF = /^(thanks|thank you|regards|best|cheers|kind regards|best regards)[,!.]?\s*\n[^\n]{0,60}$/gim;
// Quoted email history below a reply.
const QUOTED_HISTORY = /\n(?:On .{5,200} wrote:|-{2,} ?Original Message ?-{2,}|From: .+)\n[\s\S]*$/i;

/** Removes the obvious personal data from text copied out of a ticket. */
export function stripPersonalData(text: string): string {
  return text
    .replace(QUOTED_HISTORY, "\n")
    .replace(EMAIL, "[email removed]")
    .replace(PHONE, "[phone removed]")
    .replace(IPV4, "[address removed]")
    .replace(GREETING, "")
    .replace(SIGN_OFF, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Drafts an article from a resolved ticket: the subject becomes the title and
 * the public conversation becomes the body. Internal notes and system
 * messages are never included.
 */
export function draftFromTicket(
  subject: string,
  messages: TicketMessageInput[],
): { title: string; body: string } {
  const publicMessages: TicketMessageInput[] = messages
    .filter((m) => m.visibility === "public" && m.source !== "system")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const [first, ...rest] = publicMessages;
  const sections: string[] = [];
  if (first) {
    sections.push("## Problem", stripPersonalData(normalizeMarkdown(first.body)));
  }
  const replies: string[] = rest.map((m) => stripPersonalData(normalizeMarkdown(m.body))).filter(Boolean);
  if (replies.length > 0) {
    sections.push("## Solution", replies.join("\n\n"));
  }
  const title: string = stripPersonalData(subject).replace(/^\s*(re|fwd?):\s*/i, "").slice(0, 200) || "Untitled article";
  return { title, body: sections.join("\n\n") };
}
