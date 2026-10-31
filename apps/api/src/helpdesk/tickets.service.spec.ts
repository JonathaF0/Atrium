import { beforeEach, describe, expect, it, mock } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TicketsService, parseTicketQuery, queueViewWhere } from "./tickets.service";
import type { ClientScope } from "../service-core";

const ORG = "org1";
const now = new Date("2026-05-01T12:00:00Z");

function ticketRow(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    organizationId: ORG,
    number: 1001,
    subject: "Printer offline",
    status: "open",
    priority: "normal",
    source: "portal",
    categoryId: null,
    companyId: "co1",
    requesterUserId: "client-a",
    requesterContactId: "c1",
    requesterEmail: "a@example.com",
    requesterName: "Client A",
    assigneeId: null,
    projectId: null,
    taskId: null,
    assetId: null,
    mergedIntoId: null,
    triage: false,
    slaPolicyId: null,
    firstResponseDueAt: null,
    resolutionDueAt: null,
    firstRespondedAt: null,
    slaPausedAt: null,
    slaPausedSeconds: 0,
    firstResponseBreached: false,
    resolutionBreached: false,
    slaWarnedAt: null,
    emailToken: "tok",
    waitingSince: null,
    resolvedAt: null,
    closedAt: null,
    csatRating: null,
    csatComment: null,
    createdAt: now,
    lastActivityAt: now,
    ...over,
  };
}

const scopeFor = (over: Partial<ClientScope> = {}): ClientScope => ({
  userId: "client-a",
  organizationId: ORG,
  contactId: "c1",
  companyId: "co1",
  companyAdmin: false,
  email: "a@example.com",
  name: "Client A",
  ...over,
});

function build() {
  const prisma = {
    ticket: {
      findFirst: mock(async () => ticketRow() as unknown),
      findMany: mock(async () => [] as unknown[]),
      count: mock(async () => 0),
      update: mock(async (args: { data: Record<string, unknown> }) => ({ ...ticketRow(), ...args.data })),
      findUnique: mock(async () => ticketRow() as unknown),
    },
    ticketMessage: {
      findMany: mock(async () => [] as unknown[]),
      create: mock(async (args: { data: Record<string, unknown> }) => ({ id: "m1", attachments: [], ...args.data })),
    },
    ticketEvent: { findMany: mock(async () => []), createMany: mock(async () => ({ count: 1 })) },
    ticketCategory: { findUnique: mock(async () => null), findFirst: mock(async () => null), count: mock(async () => 0) },
    member: { count: mock(async () => 0) },
    user: { findUnique: mock(async () => ({ name: "Client A", email: "a@example.com" })), findMany: mock(async () => []) },
    $transaction: mock(async (fn: unknown) => (typeof fn === "function" ? (fn as (tx: unknown) => unknown)(prisma) : Promise.all(fn as unknown[]))),
  };
  const settings = {
    get: mock(async () => ({ ticketPrefix: "TKT", clientsCanClose: true, csatEnabled: true, triageAssigneeId: null })),
    nextNumber: mock(async () => ({ number: 1001, prefix: "TKT" })),
  };
  const scope = { resolve: mock(async () => scopeFor()) };
  const notifications = {
    staffReplied: mock(() => undefined),
    clientReplied: mock(() => undefined),
    statusChanged: mock(() => undefined),
    assigned: mock(() => undefined),
    ticketCreated: mock(() => undefined),
  };
  const sla = { onStatusChange: mock(async () => ({})), recompute: mock(async () => ({})), resolvePolicyId: mock(async () => null), initial: mock(async () => ({})) };
  const automation = { evaluate: mock(async () => null) };
  const audit = { record: mock(async () => undefined) };
  const defaults = { ensure: mock(async () => undefined) };
  const service = new TicketsService(
    prisma as never,
    settings as never,
    scope as never,
    {} as never,
    audit as never,
    defaults as never,
    sla as never,
    notifications as never,
    automation as never,
  );
  return { service, prisma, settings, scope, notifications, sla };
}

describe("portal scoping", () => {
  let t: ReturnType<typeof build>;
  beforeEach(() => {
    t = build();
  });

  it("returns only public messages and public events to the requester", async () => {
    await t.service.findOneForClient("t1", "client-a", ORG);
    const msgArgs = (t.prisma.ticketMessage.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(msgArgs.where).toEqual({ ticketId: "t1", visibility: "public" });
    const evArgs = (t.prisma.ticketEvent.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(evArgs.where).toEqual({ ticketId: "t1", type: { in: ["created", "status"] } });
  });

  it("hides another client's ticket as not found", async () => {
    t.scope.resolve.mockResolvedValue(scopeFor({ userId: "client-b", contactId: "c2" }));
    await expect(t.service.findOneForClient("t1", "client-b", ORG)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lets a company admin see a colleague's ticket, but not another company's", async () => {
    t.scope.resolve.mockResolvedValue(scopeFor({ userId: "client-b", companyAdmin: true }));
    await expect(t.service.findOneForClient("t1", "client-b", ORG)).resolves.toBeDefined();
    t.scope.resolve.mockResolvedValue(scopeFor({ userId: "client-b", companyAdmin: true, companyId: "co2" }));
    await expect(t.service.findOneForClient("t1", "client-b", ORG)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("looks tickets up within the caller's workspace only", async () => {
    t.prisma.ticket.findFirst.mockResolvedValue(null);
    await expect(t.service.findOneForClient("t1", "client-a", "other-org")).rejects.toBeInstanceOf(NotFoundException);
    const args = (t.prisma.ticket.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(args.where).toEqual({ id: "t1", organizationId: "other-org" });
  });

  it("lists own tickets, plus the company's for company admins", async () => {
    await t.service.listForClient("client-a", ORG, {});
    let where = (t.prisma.ticket.findMany.mock.calls[0] as unknown as [{ where: { AND: unknown[] } }])[0].where;
    expect(where.AND[0]).toEqual({ OR: [{ requesterUserId: "client-a" }] });

    t.scope.resolve.mockResolvedValue(scopeFor({ companyAdmin: true }));
    await t.service.listForClient("client-a", ORG, {});
    where = (t.prisma.ticket.findMany.mock.calls[1] as unknown as [{ where: { AND: unknown[] } }])[0].where;
    expect(where.AND[0]).toEqual({ OR: [{ requesterUserId: "client-a" }, { companyId: "co1" }] });

    await t.service.listForClient("client-a", ORG, { scope: "mine" });
    where = (t.prisma.ticket.findMany.mock.calls[2] as unknown as [{ where: { AND: unknown[] } }])[0].where;
    expect(where.AND[0]).toEqual({ requesterUserId: "client-a" });
  });

  it("only the requester can rate, and only finished tickets", async () => {
    await expect(t.service.rateAsClient("t1", "client-a", ORG, { rating: 5 })).rejects.toBeInstanceOf(BadRequestException);
    t.prisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: "resolved" }));
    t.scope.resolve.mockResolvedValue(scopeFor({ userId: "client-b", companyAdmin: true }));
    await expect(t.service.rateAsClient("t1", "client-b", ORG, { rating: 5 })).rejects.toThrow("Only the requester");
  });

  it("refuses categories that are hidden from the portal", async () => {
    await expect(
      t.service.createForClient("client-a", "member", ORG, { subject: "Help me", description: "x", categoryId: "hidden" }),
    ).rejects.toThrow("Unknown category");
    const args = (t.prisma.ticketCategory.count.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(args.where).toEqual({ id: "hidden", organizationId: ORG, portalVisible: true, archivedAt: null });
  });
});

describe("staff replies", () => {
  it("an internal note never notifies the requester and does not count as a response", async () => {
    const t = build();
    await t.service.reply("t1", ORG, { userId: "staff", name: "Alex" }, { body: "Checked logs", visibility: "internal" });
    expect(t.notifications.staffReplied).not.toHaveBeenCalled();
    const update = (t.prisma.ticket.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(update.data.firstRespondedAt).toBeUndefined();
  });

  it("the first public reply records the first response and notifies the requester", async () => {
    const t = build();
    await t.service.reply("t1", ORG, { userId: "staff", name: "Alex" }, { body: "On it" });
    const update = (t.prisma.ticket.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(update.data.firstRespondedAt).toBeInstanceOf(Date);
    expect(t.notifications.staffReplied).toHaveBeenCalledWith("t1", "m1", "Alex", "On it");
  });

  it("assigning to someone who is not staff is refused", async () => {
    const t = build();
    await expect(t.service.update("t1", ORG, { userId: "staff", name: "Alex" }, { assigneeId: "client-a" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a status change writes an event and notifies", async () => {
    const t = build();
    await t.service.changeTicket(ticketRow() as never, { status: "resolved" }, { userId: "staff", name: "Alex" }, { notifyRequester: true, skipAutomation: true });
    const events = (t.prisma.ticketEvent.createMany.mock.calls[0] as unknown as [{ data: Record<string, unknown>[] }])[0].data;
    expect(events).toEqual([{ ticketId: "t1", actorId: "staff", type: "status", fromValue: "open", toValue: "resolved", detail: null }]);
    expect(t.notifications.statusChanged).toHaveBeenCalledWith("t1", "open", "resolved", { notifyRequester: true, note: undefined });
  });

  it("a merged ticket cannot be reopened", async () => {
    const t = build();
    await expect(
      t.service.changeTicket(ticketRow({ status: "closed", mergedIntoId: "t9" }) as never, { status: "open" }, { userId: "s", name: "s" }, { notifyRequester: false }),
    ).rejects.toThrow("merged");
  });
});

describe("queue views", () => {
  it("open, unassigned, mine and triage only show active tickets", () => {
    for (const v of ["open", "unassigned", "mine", "triage"]) {
      expect(queueViewWhere(v, "u1", now).status).toEqual({ in: ["new", "open", "waiting_client", "waiting_third_party", "on_hold"] });
    }
    expect(queueViewWhere("mine", "u1", now).assigneeId).toBe("u1");
    expect(queueViewWhere("unassigned", "u1", now).assigneeId).toBeNull();
    expect(queueViewWhere("triage", "u1", now).triage).toBe(true);
    expect(queueViewWhere("closed", "u1", now)).toEqual({ status: { in: ["resolved", "closed"] } });
    expect(queueViewWhere("all", "u1", now)).toEqual({});
  });

  it("sla_risk includes breached, warned and soon-due running tickets", () => {
    const w = queueViewWhere("sla_risk", "u1", now);
    expect(w.slaPausedAt).toBeNull();
    expect(w.OR).toContainEqual({ resolutionBreached: true });
    expect(w.OR).toContainEqual({ slaWarnedAt: { not: null } });
    expect(w.OR).toContainEqual({ resolutionDueAt: { lte: new Date(now.getTime() + 3_600_000) } });
  });

  it("parses ticket numbers with or without the prefix", () => {
    expect(parseTicketQuery("TKT-1042", "TKT").number).toBe(1042);
    expect(parseTicketQuery("tkt1042", "TKT").number).toBe(1042);
    expect(parseTicketQuery("#77", "TKT").number).toBe(77);
    expect(parseTicketQuery("printer 2", "TKT").number).toBeNull();
  });
});
