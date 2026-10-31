import { describe, expect, it } from "bun:test";
import { draftFromTicket, stripPersonalData } from "./kb-from-ticket";
import type { TicketMessageInput } from "./kb-from-ticket";

function msg(body: string, overrides: Partial<TicketMessageInput> = {}, minute: number = 0): TicketMessageInput {
  return {
    visibility: "public",
    body,
    source: "portal",
    authorUserId: "u1",
    createdAt: new Date(Date.UTC(2026, 0, 1, 9, minute)),
    ...overrides,
  };
}

describe("draftFromTicket", () => {
  it("uses the subject as title and excludes internal notes and system messages", () => {
    const draft = draftFromTicket("Re: Printer shows offline", [
      msg("The office printer shows offline since this morning.", {}, 0),
      msg("Internal: client is on the old firmware, check contract", { visibility: "internal" }, 1),
      msg("Status changed to resolved", { source: "system" }, 2),
      msg("Power cycle the printer, then re-add it under Settings > Printers.", { source: "staff" }, 3),
    ]);
    expect(draft.title).toBe("Printer shows offline");
    expect(draft.body).toContain("## Problem");
    expect(draft.body).toContain("office printer shows offline");
    expect(draft.body).toContain("## Solution");
    expect(draft.body).toContain("Power cycle the printer");
    expect(draft.body).not.toContain("old firmware");
    expect(draft.body).not.toContain("Status changed");
  });

  it("orders messages by time regardless of input order", () => {
    const draft = draftFromTicket("Subject", [msg("second", {}, 5), msg("first", {}, 1)]);
    expect(draft.body.indexOf("first")).toBeLessThan(draft.body.indexOf("second"));
  });

  it("handles a ticket with no public messages", () => {
    const draft = draftFromTicket("Only notes", [msg("secret", { visibility: "internal" })]);
    expect(draft.body).toBe("");
    expect(draft.title).toBe("Only notes");
  });
});

describe("stripPersonalData", () => {
  it("removes emails, phone numbers and IP addresses", () => {
    const out = stripPersonalData("Mail sam.lee@example.com or call +1 (555) 010-2030 from 192.168.1.20");
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("010-2030");
    expect(out).not.toContain("192.168.1.20");
    expect(out).toContain("[email removed]");
    expect(out).toContain("[phone removed]");
  });

  it("drops greetings, sign-offs and quoted history", () => {
    const out = stripPersonalData("Hi Sam,\nTry restarting the router.\n\nThanks,\nAlex\n\nOn Mon, 1 Jan 2026 someone wrote:\n> old text");
    expect(out).toBe("Try restarting the router.");
  });

  it("keeps version numbers and short numbers", () => {
    expect(stripPersonalData("Update to version 2.4.1 and wait 30 seconds")).toBe("Update to version 2.4.1 and wait 30 seconds");
  });
});
