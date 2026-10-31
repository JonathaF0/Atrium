import { describe, expect, it, mock } from "bun:test";
import { UnauthorizedException } from "@nestjs/common";
import { InboundEmailService } from "./inbound.service";
import { signPayload, type ParsedEmail } from "./email-parsing";

const ORG = "org1";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";

function email(over: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    messageId: "m1@example.com",
    fromEmail: "sam@example.com",
    fromName: "Sam",
    to: ["support@example.com"],
    subject: "Printer offline",
    text: "It stopped working",
    inReplyTo: null,
    references: [],
    headers: {},
    attachments: [],
    ...over,
  };
}

function build(opts: { contact?: Record<string, unknown> | null; member?: boolean; staff?: boolean; thread?: Record<string, unknown> | null } = {}) {
  const prisma = {
    organization: { findUnique: mock(async () => ({ id: ORG })) },
    serviceSettings: { findUnique: mock(async () => ({ inboundMode: "webhook", inboundWebhookSecret: "enc" })) },
    inboundEmail: {
      create: mock(async () => ({ id: "log1" })),
      update: mock(async () => ({})),
    },
    contact: { findFirst: mock(async () => opts.contact ?? null) },
    member: {
      findFirst: mock(async (args: { where: Record<string, unknown> }) => {
        if ("role" in args.where) return opts.staff ? { userId: "staff1" } : null;
        return opts.member ? { role: "member" } : null;
      }),
    },
    ticketMessage: {
      findFirst: mock(async (args: { where: Record<string, unknown> }) => ("emailMessageId" in args.where ? (opts.thread ? { ticketId: "t1" } : null) : { id: "first" })),
      create: mock(async () => ({ id: "m-internal" })),
    },
    ticket: { findFirst: mock(async () => opts.thread ?? null) },
    ticketLink: { create: mock(async () => ({})) },
  };
  const tickets = {
    createTicket: mock(async () => ({ id: "new-ticket", organizationId: ORG })),
    addClientMessage: mock(async () => ({ id: "m-client" })),
  };
  const settingsSvc = { decrypt: mock(() => "whsec_x") };
  const serviceSettings = { get: mock(async () => ({ ticketPrefix: "TKT", inboundAddress: "support@example.com" })) };
  const audit = { record: mock(async () => undefined) };
  const service = new InboundEmailService(prisma as never, settingsSvc as never, serviceSettings as never, tickets as never, {} as never, audit as never);
  return { service, prisma, tickets, audit };
}

describe("InboundEmailService.process", () => {
  it("is idempotent on the Message-ID", async () => {
    const t = build();
    t.prisma.inboundEmail.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await t.service.process(ORG, email())).toEqual({ status: "duplicate", ticketId: null });
    expect(t.tickets.createTicket).not.toHaveBeenCalled();
  });

  it("ignores auto-replies", async () => {
    const t = build();
    const res = await t.service.process(ORG, email({ headers: { "auto-submitted": "auto-replied" } }));
    expect(res.status).toBe("ignored");
    expect(t.tickets.createTicket).not.toHaveBeenCalled();
  });

  it("sends unknown senders to triage without giving them access", async () => {
    const t = build();
    const res = await t.service.process(ORG, email({ fromEmail: "stranger@example.org" }));
    expect(res).toEqual({ status: "triaged", ticketId: "new-ticket" });
    const input = (t.tickets.createTicket.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).toMatchObject({ triage: true, requesterUserId: null, requesterContactId: null, companyId: null, acknowledge: false, source: "email" });
    expect(t.audit.record).toHaveBeenCalled();
  });

  it("opens a ticket on behalf of a contact with a portal login", async () => {
    const t = build({ contact: { id: "c1", name: "Sam Sample", companyId: "co1", userId: "u1" }, member: true });
    const res = await t.service.process(ORG, email({ subject: "Re: Fwd: Printer offline" }));
    expect(res.status).toBe("ticket_created");
    const input = (t.tickets.createTicket.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).toMatchObject({ triage: false, requesterUserId: "u1", requesterContactId: "c1", companyId: "co1", subject: "Printer offline", acknowledge: true });
  });

  it("a known contact without a login gets a ticket but no portal access", async () => {
    const t = build({ contact: { id: "c1", name: "Sam Sample", companyId: "co1", userId: null } });
    await t.service.process(ORG, email());
    const input = (t.tickets.createTicket.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).toMatchObject({ triage: false, requesterUserId: null, requesterContactId: "c1" });
  });

  it("threads a reply from the requester by In-Reply-To and strips the quote", async () => {
    const thread = { id: "t1", organizationId: ORG, status: "waiting_client", requesterEmail: "sam@example.com", companyId: "co1", mergedIntoId: null };
    const t = build({ thread });
    const res = await t.service.process(ORG, email({ inReplyTo: "abc@example.com", text: "Works now\n\nOn Mon, Support wrote:\n> try again" }));
    expect(res).toEqual({ status: "reply_added", ticketId: "t1" });
    const call = t.tickets.addClientMessage.mock.calls[0] as unknown as [unknown, { email: string }, string, string];
    expect(call[2]).toBe("Works now");
    expect(call[3]).toBe("email");
    expect(t.tickets.createTicket).not.toHaveBeenCalled();
  });

  it("threads by the ticket token in the subject", async () => {
    const thread = { id: "t1", organizationId: ORG, status: "open", requesterEmail: "sam@example.com", companyId: null, mergedIntoId: null };
    const t = build({ thread });
    t.prisma.ticketMessage.findFirst.mockResolvedValue({ id: "first" } as never);
    const res = await t.service.process(ORG, email({ subject: `Re: [TKT-1001:${TOKEN}] Printer` }));
    expect(res.status).toBe("reply_added");
    const where = (t.prisma.ticket.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toEqual({ emailToken: TOKEN, organizationId: ORG });
  });

  it("keeps mail from someone else on the thread as an internal note", async () => {
    const thread = { id: "t1", organizationId: ORG, status: "open", requesterEmail: "sam@example.com", companyId: "co1", mergedIntoId: null };
    const t = build({ thread });
    await t.service.process(ORG, email({ fromEmail: "other@example.org", inReplyTo: "abc@example.com" }));
    expect(t.tickets.addClientMessage).not.toHaveBeenCalled();
    const data = (t.prisma.ticketMessage.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.visibility).toBe("internal");
  });

  it("a reply to a closed ticket opens a new linked ticket", async () => {
    const thread = { id: "t1", organizationId: ORG, status: "closed", requesterEmail: "sam@example.com", companyId: "co1", mergedIntoId: null };
    const t = build({ thread, contact: { id: "c1", name: "Sam", companyId: "co1", userId: null } });
    const res = await t.service.process(ORG, email({ inReplyTo: "abc@example.com" }));
    expect(res.status).toBe("ticket_created");
    expect(t.prisma.ticketLink.create).toHaveBeenCalledWith({ data: { ticketId: "new-ticket", relatedTicketId: "t1", type: "related" } });
  });
});

describe("InboundEmailService.receiveWebhook", () => {
  const body = Buffer.from(JSON.stringify({ from: "sam@example.com", subject: "Hi", text: "Hello", messageId: "<w1@example.com>" }));
  const ts = String(Math.floor(Date.now() / 1000));

  it("rejects a bad signature before parsing", async () => {
    const t = build();
    await expect(t.service.receiveWebhook("acme", body, `sha256=${"0".repeat(64)}`, ts)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(t.prisma.inboundEmail.create).not.toHaveBeenCalled();
  });

  it("rejects when the workspace is not in webhook mode", async () => {
    const t = build();
    t.prisma.serviceSettings.findUnique.mockResolvedValue({ inboundMode: "imap", inboundWebhookSecret: "enc" });
    await expect(t.service.receiveWebhook("acme", body, `sha256=${signPayload("whsec_x", ts, body)}`, ts)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("accepts a correctly signed payload", async () => {
    const t = build({ contact: { id: "c1", name: "Sam", companyId: null, userId: null } });
    const res = await t.service.receiveWebhook("acme", body, `sha256=${signPayload("whsec_x", ts, body)}`, ts);
    expect(res.status).toBe("ticket_created");
    const log = (t.prisma.inboundEmail.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(log.messageId).toBe("w1@example.com");
  });
});
