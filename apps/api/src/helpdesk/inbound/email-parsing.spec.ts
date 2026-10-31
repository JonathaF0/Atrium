import { describe, expect, it } from "bun:test";
import {
  displayName,
  findTicketToken,
  headerMap,
  htmlToText,
  isAutomatedEmail,
  normalizeAddress,
  parseMessageIds,
  plusAddress,
  signPayload,
  stripQuotedReply,
  verifySignature,
} from "./email-parsing";

const SECRET = "whsec_test";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";

describe("verifySignature", () => {
  const body = Buffer.from('{"from":"a@example.com"}');
  const now = new Date("2026-06-01T12:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));
  const sig = `sha256=${signPayload(SECRET, ts, body)}`;

  it("accepts a valid signature", () => {
    expect(verifySignature(SECRET, body, sig, ts, now)).toBe(true);
    expect(verifySignature(SECRET, body, sig.toUpperCase().replace("SHA256", "sha256"), ts, now)).toBe(true);
  });

  it("rejects a tampered body, wrong secret or wrong timestamp", () => {
    expect(verifySignature(SECRET, Buffer.from('{"from":"b@example.com"}'), sig, ts, now)).toBe(false);
    expect(verifySignature("other", body, sig, ts, now)).toBe(false);
    expect(verifySignature(SECRET, body, sig, String(Number(ts) + 1), now)).toBe(false);
  });

  it("rejects stale or future timestamps beyond five minutes", () => {
    const old = String(Number(ts) - 301);
    expect(verifySignature(SECRET, body, `sha256=${signPayload(SECRET, old, body)}`, old, now)).toBe(false);
    const fresh = String(Number(ts) - 299);
    expect(verifySignature(SECRET, body, `sha256=${signPayload(SECRET, fresh, body)}`, fresh, now)).toBe(true);
  });

  it("rejects missing or malformed headers", () => {
    expect(verifySignature(SECRET, body, undefined, ts, now)).toBe(false);
    expect(verifySignature(SECRET, body, sig, undefined, now)).toBe(false);
    expect(verifySignature(SECRET, body, "md5=abc", ts, now)).toBe(false);
    expect(verifySignature(SECRET, body, sig, "yesterday", now)).toBe(false);
    expect(verifySignature("", body, sig, ts, now)).toBe(false);
  });
});

describe("addresses", () => {
  it("normalizes display-name addresses", () => {
    expect(normalizeAddress('"Sam Sample" <Sam@Example.COM>')).toBe("sam@example.com");
    expect(normalizeAddress("not an address")).toBeNull();
    expect(displayName('"Sam Sample" <sam@example.com>')).toBe("Sam Sample");
    expect(displayName("sam@example.com")).toBeNull();
  });

  it("builds a plus-address for replies", () => {
    expect(plusAddress("support@example.com", TOKEN)).toBe(`support+${TOKEN}@example.com`);
    expect(plusAddress("support+old@example.com", TOKEN)).toBe(`support+${TOKEN}@example.com`);
    expect(plusAddress(null, TOKEN)).toBeNull();
  });

  it("parses message id lists", () => {
    expect(parseMessageIds("<a@x> <b@y>")).toEqual(["a@x", "b@y"]);
    expect(parseMessageIds(["<a@x>", "<c@z>"])).toEqual(["a@x", "c@z"]);
    expect(parseMessageIds("bare@id")).toEqual(["bare@id"]);
    expect(parseMessageIds(null)).toEqual([]);
  });
});

describe("findTicketToken", () => {
  const base = { subject: "Re: help", text: "", to: ["support@example.com"] };

  it("finds the token in the subject", () => {
    expect(findTicketToken({ ...base, subject: `Re: [TKT-1042:${TOKEN}] Printer` }, "TKT")).toBe(TOKEN);
  });

  it("finds the token in a plus-address", () => {
    expect(findTicketToken({ ...base, to: [`support+${TOKEN}@example.com`] }, "TKT")).toBe(TOKEN);
  });

  it("finds the token in a quoted footer", () => {
    expect(findTicketToken({ ...base, text: `Thanks\n> Ticket reference: [TKT-1042:${TOKEN}]` }, "TKT")).toBe(TOKEN);
  });

  it("never trusts a bare ticket number", () => {
    expect(findTicketToken({ ...base, subject: "Re: [TKT-1042] Printer" }, "TKT")).toBeNull();
  });

  it("ignores another workspace's prefix and short plus tags", () => {
    expect(findTicketToken({ ...base, subject: `[OPS-1:${TOKEN}]` }, "TKT")).toBeNull();
    expect(findTicketToken({ ...base, to: ["support+news@example.com"] }, "TKT")).toBeNull();
  });
});

describe("stripQuotedReply", () => {
  it("cuts at a Gmail-style quote header", () => {
    const text = "Thanks, that fixed it.\n\nOn Mon, Mar 2, 2026 at 10:00 AM Support <support@example.com> wrote:\n> Please restart.\n";
    expect(stripQuotedReply(text)).toBe("Thanks, that fixed it.");
  });

  it("handles a wrapped quote header", () => {
    const text = "Still broken.\n\nOn Mon, Mar 2, 2026 at 10:00 AM Support Team <support@example.com>\nwrote:\n> old";
    expect(stripQuotedReply(text)).toBe("Still broken.");
  });

  it("cuts at an Outlook original-message block", () => {
    expect(stripQuotedReply("New info\r\n\r\n-----Original Message-----\r\nFrom: x\r\n")).toBe("New info");
    expect(stripQuotedReply("Done\n\nFrom: Support <support@example.com>\nSent: Monday\nTo: me\n\nold")).toBe("Done");
  });

  it("keeps a body line that merely starts with From:", () => {
    expect(stripQuotedReply("From: the logs it looks fine.\nThanks")).toBe("From: the logs it looks fine.\nThanks");
  });

  it("drops trailing quoted lines and signatures", () => {
    expect(stripQuotedReply("Yes please\n\n> earlier\n> more")).toBe("Yes please");
    expect(stripQuotedReply("Sure\n-- \nSam\nSample Co")).toBe("Sure");
  });

  it("keeps inline quotes followed by new text", () => {
    expect(stripQuotedReply("> question?\nanswer")).toBe("> question?\nanswer");
  });

  it("falls back to the full text when nothing would remain", () => {
    expect(stripQuotedReply("> only a quote")).toBe("> only a quote");
  });
});

describe("isAutomatedEmail", () => {
  it("detects auto-replies, bulk mail and bounces", () => {
    expect(isAutomatedEmail({ "auto-submitted": "auto-replied" }, "a@example.com")).toBe(true);
    expect(isAutomatedEmail({ "auto-submitted": "no" }, "a@example.com")).toBe(false);
    expect(isAutomatedEmail({ precedence: "bulk" }, "a@example.com")).toBe(true);
    expect(isAutomatedEmail({ "x-autoreply": "yes" }, "a@example.com")).toBe(true);
    expect(isAutomatedEmail({ "list-id": "<news.example.com>" }, "a@example.com")).toBe(true);
    expect(isAutomatedEmail({ "content-type": "multipart/report; report-type=delivery-status" }, "a@example.com")).toBe(true);
    expect(isAutomatedEmail({}, "MAILER-DAEMON@example.com")).toBe(true);
    expect(isAutomatedEmail({}, "noreply@example.com")).toBe(true);
    expect(isAutomatedEmail({}, "sam@example.com")).toBe(false);
  });

  it("reads headers in any shape", () => {
    expect(headerMap({ "Auto-Submitted": "auto-generated" })).toEqual({ "auto-submitted": "auto-generated" });
    expect(headerMap([{ name: "Precedence", value: "bulk" }])).toEqual({ precedence: "bulk" });
    expect(headerMap(null)).toEqual({});
  });
});

describe("htmlToText", () => {
  it("drops tags, scripts and quoted blocks", () => {
    const html = "<p>Hello&nbsp;there</p><script>alert(1)</script><blockquote>old</blockquote><div>Line 2 &amp; more</div>";
    expect(htmlToText(html)).toBe("Hello there\nLine 2 & more");
  });
});
