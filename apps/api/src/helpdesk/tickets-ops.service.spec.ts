import { describe, expect, it, mock } from "bun:test";
import { TicketsOpsService, supportProjectName } from "./tickets-ops.service";

const ORG = "org1";
const actor = { userId: "staff", name: "Alex" };

function t(id: string, number: number, over: Record<string, unknown> = {}) {
  return { id, number, organizationId: ORG, subject: `Subject ${number}`, status: "open", requesterEmail: `${id}@example.com`, mergedIntoId: null, companyId: null, projectId: null, ...over };
}

function build() {
  const prisma = {
    ticket: {
      findMany: mock(async () => [] as unknown[]),
      update: mock(async () => ({})),
    },
    ticketEvent: { create: mock(async (a: unknown) => a) },
    ticketMessage: {
      create: mock(async (a: unknown) => a),
      findFirst: mock(async () => null as unknown),
      delete: mock(async (a: unknown) => a),
    },
    ticketAttachment: { updateMany: mock(async (a: unknown) => a) },
    ticketLink: { create: mock(async (a: unknown) => a) },
    label: { findFirst: mock(async () => null as unknown) },
    company: { findFirst: mock(async () => null as unknown) },
    timeEntry: { update: mock(async (a: { data: Record<string, unknown> }) => ({ id: "te1", ...a.data })) },
    $transaction: mock(async (ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(prisma))),
  };
  const tickets = {
    getOrThrow: mock(async (id: string) => t(id, 1000)),
    changeTicket: mock(async (ticket: unknown) => ticket),
    isStaff: mock(async () => true),
    addLabel: mock(async () => ({ ok: true })),
    findOne: mock(async (id: string) => ({ id })),
    createTicket: mock(async () => t("new", 1005)),
    assertProject: mock(async () => ({ id: "p1", name: "P" })),
  };
  const timeEntries = { create: mock(async () => ({ id: "te1" })) };
  const audit = { record: mock(async () => undefined) };
  const settings = { get: mock(async () => ({ ticketPrefix: "TKT" })) };
  const contracts = {
    coverageFor: mock(async () => ({ defaultBillable: true, defaultContractId: null as string | null })),
  };
  const service = new TicketsOpsService(
    prisma as never,
    tickets as never,
    timeEntries as never,
    audit as never,
    settings as never,
    contracts as never,
  );
  return { service, prisma, tickets, timeEntries, audit, contracts };
}

describe("bulk actions", () => {
  it("only touches tickets in the caller's workspace", async () => {
    const s = build();
    s.prisma.ticket.findMany.mockResolvedValue([t("a", 1), t("b", 2)]);
    const res = await s.service.bulk(ORG, actor, { ids: ["a", "b", "foreign"], action: "close" });
    const where = (s.prisma.ticket.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toEqual({ id: { in: ["a", "b", "foreign"] }, organizationId: ORG });
    expect(res).toEqual({ updated: 2, failed: [], notFound: 1 });
    expect(s.tickets.changeTicket).toHaveBeenCalledTimes(2);
    expect(s.audit.record).toHaveBeenCalledTimes(1);
  });

  it("validates the value before changing anything", async () => {
    const s = build();
    await expect(s.service.bulk(ORG, actor, { ids: ["a"], action: "priority", value: "extreme" })).rejects.toThrow("Invalid priority");
    s.tickets.isStaff.mockResolvedValue(false);
    await expect(s.service.bulk(ORG, actor, { ids: ["a"], action: "assign", value: "client" })).rejects.toThrow("owner or admin");
    await expect(s.service.bulk(ORG, actor, { ids: ["a"], action: "add_label", value: "other-org-label" })).rejects.toThrow("Unknown label");
    expect(s.tickets.changeTicket).not.toHaveBeenCalled();
  });
});

describe("merge", () => {
  it("closes the sources, points them at the target and notifies each requester once", async () => {
    const s = build();
    s.prisma.ticket.findMany.mockResolvedValue([
      t("s1", 1001, { requesterEmail: "sam@example.com" }),
      t("s2", 1002, { requesterEmail: "sam@example.com" }),
      t("s3", 1003, { requesterEmail: "kim@example.com" }),
    ]);
    await s.service.merge("target", ORG, actor, ["s1", "s2", "s3", "target"]);
    const calls = s.tickets.changeTicket.mock.calls as unknown as [{ id: string }, { status: string }, unknown, { notifyRequester: boolean }][];
    expect(calls.map((c) => [c[0].id, c[1].status, c[3].notifyRequester])).toEqual([
      ["s1", "closed", true],
      ["s2", "closed", false],
      ["s3", "closed", true],
    ]);
    const updates = (s.prisma.ticket.update.mock.calls as unknown as [{ where: { id: string }; data: Record<string, unknown> }][]).map((c) => c[0]);
    expect(updates.filter((u) => u.data.mergedIntoId === "target").map((u) => u.where.id)).toEqual(["s1", "s2", "s3"]);
    const note = (s.prisma.ticketMessage.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(note.visibility).toBe("internal");
    expect(note.body).toContain("TKT-1002");
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "ticket.merged", targetId: "target" }));
  });

  it("refuses sources that are missing, foreign or already merged", async () => {
    const s = build();
    s.prisma.ticket.findMany.mockResolvedValue([t("s1", 1001)]);
    await expect(s.service.merge("target", ORG, actor, ["s1", "foreign"])).rejects.toThrow("not found or are already merged");
    await expect(s.service.merge("target", ORG, actor, ["target"])).rejects.toThrow("at least one other ticket");
  });
});

describe("split", () => {
  it("moves the message and its attachments to a new linked ticket", async () => {
    const s = build();
    s.prisma.ticketMessage.findFirst
      .mockResolvedValueOnce({ id: "msg2", body: "Also my monitor flickers", authorUserId: "u1", authorName: "Sam", authorEmail: "sam@example.com", source: "portal" })
      .mockResolvedValueOnce({ id: "msg1" })
      .mockResolvedValueOnce({ id: "new-first" });
    await s.service.split("t1", ORG, actor, { messageId: "msg2" });
    const input = (s.tickets.createTicket.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).toMatchObject({ body: "Also my monitor flickers", acknowledge: false, author: { userId: "u1", name: "Sam", email: "sam@example.com" } });
    expect(s.prisma.ticketAttachment.updateMany).toHaveBeenCalledWith({ where: { messageId: "msg2" }, data: { ticketId: "new", messageId: "new-first" } });
    expect(s.prisma.ticketMessage.delete).toHaveBeenCalledWith({ where: { id: "msg2" } });
    expect(s.prisma.ticketLink.create).toHaveBeenCalledWith({ data: { ticketId: "new", relatedTicketId: "t1", type: "split_from" } });
  });

  it("will not split off the first message", async () => {
    const s = build();
    s.prisma.ticketMessage.findFirst.mockResolvedValueOnce({ id: "msg1", body: "x" }).mockResolvedValueOnce({ id: "msg1" });
    await expect(s.service.split("t1", ORG, actor, { messageId: "msg1" })).rejects.toThrow("first message");
  });
});

describe("time", () => {
  it("logs through TimeEntriesService on the ticket's project and applies the company rate", async () => {
    const s = build();
    s.tickets.getOrThrow.mockResolvedValue(t("t1", 1001, { projectId: "p1", companyId: "co1" }));
    s.prisma.company.findFirst.mockResolvedValue({ hourlyRateCents: 15000 });
    const end = "2026-05-01T12:00:00.000Z";
    const entry = await s.service.logTime("t1", ORG, "staff", { minutes: 45, endedAt: end, billable: true });
    expect(s.timeEntries.create).toHaveBeenCalledWith("staff", ORG, {
      projectId: "p1",
      description: "Ticket #1001: Subject 1001",
      startedAt: "2026-05-01T11:15:00.000Z",
      endedAt: end,
      billable: true,
    });
    expect(entry).toMatchObject({ ticketId: "t1", hourlyRateCents: 15000 });
  });

  it("keeps the project/member rate when the company has none", async () => {
    const s = build();
    s.tickets.getOrThrow.mockResolvedValue(t("t1", 1001, { projectId: "p1", companyId: "co1" }));
    s.prisma.company.findFirst.mockResolvedValue({ hourlyRateCents: null });
    await s.service.logTime("t1", ORG, "staff", { minutes: 10 });
    const data = (s.prisma.timeEntry.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toEqual({ ticketId: "t1" });
  });

  it("counts time against a contract with covered hours left when billable isn't given", async () => {
    const s = build();
    s.tickets.getOrThrow.mockResolvedValue(t("t1", 1001, { projectId: "p1", companyId: "co1" }));
    s.contracts.coverageFor.mockResolvedValue({ defaultBillable: false, defaultContractId: "k1" });
    await s.service.logTime("t1", ORG, "staff", { minutes: 30 });
    expect(s.contracts.coverageFor).toHaveBeenCalledWith(ORG, "co1");
    const created = (s.timeEntries.create.mock.calls[0] as unknown as [string, string, { billable: boolean }])[2];
    expect(created.billable).toBe(false);
    const data = (s.prisma.timeEntry.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toEqual({ ticketId: "t1", contractId: "k1" });
  });

  it("respects an explicit billable choice over the contract", async () => {
    const s = build();
    s.tickets.getOrThrow.mockResolvedValue(t("t1", 1001, { projectId: "p1", companyId: "co1" }));
    s.contracts.coverageFor.mockResolvedValue({ defaultBillable: false, defaultContractId: "k1" });
    await s.service.logTime("t1", ORG, "staff", { minutes: 30, billable: true });
    expect(s.contracts.coverageFor).not.toHaveBeenCalled();
    const data = (s.prisma.timeEntry.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toEqual({ ticketId: "t1" });
  });

  it("names the per-company support project", () => {
    expect(supportProjectName("Sample Co")).toBe("Support — Sample Co");
    expect(supportProjectName(null)).toBe("Support");
  });
});
