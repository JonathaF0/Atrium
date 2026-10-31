import "../common/testing/mock-email";
import { describe, expect, it, mock } from "bun:test";
import { HelpdeskNotificationsService, OUTBOUND_ID_TOKEN, outboundMessageId } from "./helpdesk-notifications.service";
import { fakeEmailRenderer } from "../common/testing/fake-email-renderer";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";

function build(settings: Record<string, unknown> = { ticketPrefix: "TKT", inboundAddress: "support@example.com", inboundMode: "webhook", autoAcknowledge: true }) {
  const ticket = {
    id: "t1",
    organizationId: "org1",
    number: 1042,
    subject: "Printer offline",
    status: "open",
    priority: "high",
    emailToken: TOKEN,
    requesterEmail: "sam@example.com",
    requesterName: "Sam",
    requesterUserId: "u1",
    assigneeId: null,
    triage: false,
    projectId: null,
    slaPolicyId: null,
  };
  const prisma = {
    ticket: { findUnique: mock(async () => ticket) },
    serviceSettings: { findUnique: mock(async () => settings) },
    organization: { findUnique: mock(async () => ({ name: "Sample Workspace" })) },
    ticketMessage: { findFirst: mock(async () => ({ body: "first" })), findMany: mock(async () => []), updateMany: mock(async () => ({ count: 1 })) },
    member: { findMany: mock(async () => [{ userId: "admin1", user: { name: "Admin", email: "admin@example.com" } }]) },
  };
  const mail = { send: mock(async () => ({ sent: true, viaOrgConfig: false })) };
  const inApp = { createMany: mock(async () => undefined) };
  const push = { sendToMany: mock(async () => undefined) };
  const integrations = { dispatch: mock(() => undefined) };
  const logger = { error: mock(() => undefined), warn: mock(() => undefined) };
  const config = { get: (_k: string, d: string) => d };
  const service = new HelpdeskNotificationsService(
    prisma as never,
    mail as never,
    fakeEmailRenderer(),
    inApp as never,
    push as never,
    integrations as never,
    config as never,
    logger as never,
  );
  return { service, prisma, mail, inApp, integrations };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("HelpdeskNotificationsService", () => {
  it("emails a staff reply to the requester with the ticket subject format, Reply-To and threading headers", async () => {
    const s = build();
    s.service.staffReplied("t1", "m1", "Alex", "Please **restart** it");
    await flush();
    const [to, subject, html, org, opts] = s.mail.send.mock.calls[0] as unknown as [string, string, string, string, { replyTo: string; headers: Record<string, string> }];
    expect(to).toBe("sam@example.com");
    expect(subject).toBe("[TKT-1042] Printer offline");
    expect(org).toBe("org1");
    expect(opts.replyTo).toBe(`support+${TOKEN}@example.com`);
    expect(opts.headers["Message-ID"]).toMatch(/^<t\./);
    expect(html).toContain(`[TKT-1042:${TOKEN}]`);
    expect(html).toContain("Please restart it");
    expect(s.prisma.ticketMessage.updateMany).toHaveBeenCalled();
    expect(s.integrations.dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: "ticket.replied" }));
  });

  it("omits Reply-To when inbound email is off", async () => {
    const s = build({ ticketPrefix: "TKT", inboundAddress: null, inboundMode: "none" });
    s.service.staffReplied("t1", "m1", "Alex", "Hi");
    await flush();
    const opts = (s.mail.send.mock.calls[0] as unknown as [string, string, string, string, { replyTo?: string }])[4];
    expect(opts.replyTo).toBeUndefined();
  });

  it("a new ticket alerts admins and acknowledges the requester", async () => {
    const s = build();
    s.service.ticketCreated("t1", { acknowledge: true });
    await flush();
    const recipients = s.mail.send.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(recipients).toEqual(["admin@example.com", "sam@example.com"]);
    const ackOpts = (s.mail.send.mock.calls[1] as unknown as [string, string, string, string, { headers: Record<string, string> }])[4];
    expect(ackOpts.headers["Auto-Submitted"]).toBe("auto-replied");
    expect(s.integrations.dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: "ticket.created" }));
  });

  it("internal status shuffles do not email the requester", async () => {
    const s = build();
    s.service.statusChanged("t1", "open", "on_hold", { notifyRequester: true });
    await flush();
    expect(s.mail.send).not.toHaveBeenCalled();
    s.service.statusChanged("t1", "open", "resolved", { notifyRequester: true });
    await flush();
    expect(s.mail.send).toHaveBeenCalledTimes(1);
  });

  it("outbound message ids carry the token for threading", () => {
    const id = outboundMessageId(TOKEN, "example.com");
    expect(OUTBOUND_ID_TOKEN.exec(id)?.[1]).toBe(TOKEN);
  });
});
