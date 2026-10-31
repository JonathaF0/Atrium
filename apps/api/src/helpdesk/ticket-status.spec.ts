import { describe, expect, it } from "bun:test";
import { ACTIVE_STATUSES, clientMay, isDone, statusAfterClientReply, statusSideEffects } from "./ticket-status";
import { canned } from "./canned.fixture";
import { cannedVariables, renderCanned } from "./canned";

const now = new Date("2026-05-01T12:00:00Z");
const base = { status: "open", resolvedAt: null, closedAt: null, waitingSince: null };

describe("statusSideEffects", () => {
  it("stamps resolvedAt when resolved", () => {
    expect(statusSideEffects(base, "resolved", now)).toEqual({ status: "resolved", resolvedAt: now, closedAt: null });
  });

  it("stamps closedAt and fills a missing resolvedAt when closed", () => {
    expect(statusSideEffects(base, "closed", now)).toEqual({ status: "closed", closedAt: now, resolvedAt: now });
    const resolvedAt = new Date("2026-04-30T00:00:00Z");
    expect(statusSideEffects({ ...base, status: "resolved", resolvedAt }, "closed", now)).toEqual({ status: "closed", closedAt: now });
  });

  it("clears the finished timestamps on reopen", () => {
    const closed = { ...base, status: "closed", resolvedAt: now, closedAt: now };
    expect(statusSideEffects(closed, "open", now)).toEqual({ status: "open", resolvedAt: null, closedAt: null });
  });

  it("tracks waitingSince while waiting on the client", () => {
    expect(statusSideEffects(base, "waiting_client", now)).toEqual({ status: "waiting_client", waitingSince: now });
    const waiting = { ...base, status: "waiting_client", waitingSince: new Date("2026-04-01T00:00:00Z") };
    expect(statusSideEffects(waiting, "open", now)).toEqual({ status: "open", waitingSince: null });
  });
});

describe("client permissions", () => {
  const settings = { clientsCanClose: true, csatEnabled: true };

  it("lets clients reply until a ticket is closed", () => {
    expect(clientMay("reply", { status: "resolved", mergedIntoId: null }, settings)).toBe(true);
    expect(clientMay("reply", { status: "closed", mergedIntoId: null }, settings)).toBe(false);
  });

  it("only reopens resolved tickets", () => {
    expect(clientMay("reopen", { status: "resolved", mergedIntoId: null }, settings)).toBe(true);
    expect(clientMay("reopen", { status: "closed", mergedIntoId: null }, settings)).toBe(false);
    expect(clientMay("reopen", { status: "open", mergedIntoId: null }, settings)).toBe(false);
  });

  it("closing depends on the workspace setting", () => {
    expect(clientMay("close", { status: "open", mergedIntoId: null }, settings)).toBe(true);
    expect(clientMay("close", { status: "open", mergedIntoId: null }, { ...settings, clientsCanClose: false })).toBe(false);
  });

  it("rating needs CSAT on and a finished ticket", () => {
    expect(clientMay("rate", { status: "resolved", mergedIntoId: null }, settings)).toBe(true);
    expect(clientMay("rate", { status: "open", mergedIntoId: null }, settings)).toBe(false);
    expect(clientMay("rate", { status: "closed", mergedIntoId: null }, { ...settings, csatEnabled: false })).toBe(false);
  });

  it("merged tickets are read-only", () => {
    for (const a of ["reply", "reopen", "close", "rate"] as const) {
      expect(clientMay(a, { status: "closed", mergedIntoId: "t2" }, settings)).toBe(false);
    }
  });

  it("a client reply hands waiting or resolved tickets back to staff", () => {
    expect(statusAfterClientReply("waiting_client")).toBe("open");
    expect(statusAfterClientReply("resolved")).toBe("open");
    expect(statusAfterClientReply("on_hold")).toBeNull();
    expect(statusAfterClientReply("new")).toBeNull();
  });

  it("active statuses exclude finished ones", () => {
    expect(ACTIVE_STATUSES).not.toContain("resolved");
    expect(ACTIVE_STATUSES).not.toContain("closed");
    expect(isDone("closed")).toBe(true);
  });
});

describe("canned responses", () => {
  it("fills every variable", () => {
    const vars = cannedVariables(canned);
    expect(vars["ticket.number"]).toBe("TKT-1042");
    expect(vars["ticket.status"]).toBe("Waiting on client");
    expect(vars["requester.firstName"]).toBe("Sam");
    expect(vars["agent.firstName"]).toBe("Alex");
    expect(vars["company.name"]).toBe("Sample Co");
  });

  it("renders a template and blanks unknown variables", () => {
    expect(renderCanned("Hi {{requester.firstName}}, about {{ ticket.number }} {{nope}}- {{agent.name}}", canned)).toBe(
      "Hi Sam, about TKT-1042 - Alex Agent",
    );
  });

  it("copes with missing names", () => {
    expect(renderCanned("Hi {{requester.firstName}}!", { ...canned, requesterName: null })).toBe("Hi !");
  });
});
