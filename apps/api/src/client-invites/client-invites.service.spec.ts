import { describe, expect, it, mock } from "bun:test";
import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fakeEmailRenderer } from "../common/testing/fake-email-renderer";
import { ClientInvitesService } from "./client-invites.service";

const ORG = "org1";
const actor = { userId: "u-staff", name: "Sam Staff", email: "staff@example.com", apiKeyId: "key1" };

interface Setup {
  member?: { role: string } | null;
  pending?: { id: string } | null;
  company?: { id: string; name: string } | null;
  contact?: Record<string, unknown>;
}

function build(setup: Setup = {}) {
  const contact = {
    id: "c1",
    organizationId: ORG,
    email: "lee@example.com",
    name: "lee@example.com",
    firstName: null,
    lastName: null,
    phone: null,
    jobTitle: null,
    companyId: null,
    status: "lead",
    ...setup.contact,
  };
  const prisma = {
    member: { findFirst: mock(async () => setup.member ?? null) },
    invitation: {
      findFirst: mock(async () => setup.pending ?? null),
      create: mock(async (a: { data: Record<string, unknown> }) => ({ ...a.data, organization: { name: "Sample Workspace" } })),
    },
    company: {
      findFirst: mock(async () => setup.company ?? null),
      create: mock(async (a: { data: { name: string } }) => ({ id: "co-new", name: a.data.name })),
    },
    contact: {
      update: mock(async (a: { data: Record<string, unknown> }) => ({ ...contact, ...a.data })),
    },
  };
  const mail = { send: mock(async () => ({ sent: true, viaOrgConfig: false })) };
  const billing = { assertPlanLimit: mock(async () => undefined) };
  const contactSync = {
    ensureForInvitee: mock(async () => contact),
    recordInvited: mock(async () => undefined),
  };
  const audit = { record: mock(async () => undefined) };
  const service = new ClientInvitesService(
    prisma as never,
    mail as never,
    fakeEmailRenderer(),
    billing as never,
    contactSync as never,
    audit as never,
    new ConfigService({ WEB_URL: "https://portal.example.com" }),
  );
  const updated = (): Record<string, unknown> =>
    (prisma.contact.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
  return { service, prisma, mail, billing, contactSync, audit, updated };
}

describe("ClientInvitesService.invite", () => {
  it("creates the contact details, the company and a portal invitation, and emails it", async () => {
    const s = build();
    const res = await s.service.invite(ORG, actor, {
      email: " Lee@Example.com ",
      firstName: "Lee",
      lastName: "Park",
      company: "Sample Recovery",
      phone: "555-0100",
      externalId: "00Q123",
    });

    expect(res.status).toBe("invited");
    expect(res.emailSent).toBe(true);
    expect(s.contactSync.ensureForInvitee).toHaveBeenCalledWith(ORG, "lee@example.com");
    expect(s.prisma.company.create).toHaveBeenCalledWith({ data: { organizationId: ORG, name: "Sample Recovery" } });
    expect(s.updated()).toMatchObject({
      name: "Lee Park",
      firstName: "Lee",
      lastName: "Park",
      phone: "555-0100",
      companyId: "co-new",
      status: "client",
    });

    const invitation = (s.prisma.invitation.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(invitation).toMatchObject({ organizationId: ORG, email: "lee@example.com", role: "member", status: "pending", inviterId: "u-staff" });
    expect(String(invitation.id).length).toBeGreaterThanOrEqual(24);
    expect(s.contactSync.recordInvited).toHaveBeenCalledWith(ORG, "lee@example.com", "member");

    const [to, subject, html] = s.mail.send.mock.calls[0] as unknown as [string, string, string];
    expect(to).toBe("lee@example.com");
    expect(subject).toContain("Sample Workspace");
    expect(html).toContain(`https://portal.example.com/accept-invite?id=${invitation.id}`);

    const entry = (s.audit.record.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(entry).toMatchObject({ action: "member.invited", targetId: "c1", metadata: { via: "api_key", externalId: "00Q123", emailSent: true } });
  });

  it("does not send a second invitation while one is pending", async () => {
    const s = build({ pending: { id: "inv-old" } });
    const res = await s.service.invite(ORG, actor, { email: "lee@example.com" });
    expect(res).toMatchObject({ status: "already_invited", invitationId: "inv-old", emailSent: false });
    expect(s.prisma.invitation.create).not.toHaveBeenCalled();
    expect(s.mail.send).not.toHaveBeenCalled();
  });

  it("sends a fresh invitation when asked to resend", async () => {
    const s = build({ pending: { id: "inv-old" } });
    const res = await s.service.invite(ORG, actor, { email: "lee@example.com", resend: true });
    expect(res.status).toBe("invited");
    expect(s.mail.send).toHaveBeenCalledTimes(1);
  });

  it("reports an existing portal client without inviting them again", async () => {
    const s = build({ member: { role: "member" } });
    const res = await s.service.invite(ORG, actor, { email: "lee@example.com" });
    expect(res.status).toBe("already_client");
    expect(s.prisma.invitation.create).not.toHaveBeenCalled();
    expect(s.mail.send).not.toHaveBeenCalled();
  });

  it("refuses an email that belongs to staff", async () => {
    const s = build({ member: { role: "admin" } });
    await expect(s.service.invite(ORG, actor, { email: "lee@example.com" })).rejects.toBeInstanceOf(ConflictException);
    expect(s.contactSync.ensureForInvitee).not.toHaveBeenCalled();
  });

  it("reuses a company with the same name, whatever the case", async () => {
    const s = build({ company: { id: "co1", name: "Sample Recovery" } });
    await s.service.invite(ORG, actor, { email: "lee@example.com", company: "sample recovery" });
    expect(s.prisma.company.create).not.toHaveBeenCalled();
    expect(s.updated()).toMatchObject({ companyId: "co1" });
  });

  it("never overwrites details staff already entered", async () => {
    const s = build({
      contact: { name: "Lee P.", firstName: "Lee", lastName: "P.", phone: "555-0199", companyId: "co-x", status: "client" },
    });
    await s.service.invite(ORG, actor, { email: "lee@example.com", firstName: "Leon", lastName: "Park", phone: "555-0100", company: "Other" });
    expect(s.updated()).toEqual({});
  });

  it("still invites when the email can't be sent, and says so", async () => {
    const s = build();
    s.mail.send.mockImplementation(async () => ({ sent: false, viaOrgConfig: false }));
    const res = await s.service.invite(ORG, actor, { email: "lee@example.com" });
    expect(res).toMatchObject({ status: "invited", emailSent: false });
  });

  it("checks the plan's client limit before inviting", async () => {
    const s = build();
    s.billing.assertPlanLimit.mockImplementation(async () => {
      throw new Error("Client limit reached");
    });
    await expect(s.service.invite(ORG, actor, { email: "lee@example.com" })).rejects.toThrow("Client limit reached");
    expect(s.prisma.invitation.create).not.toHaveBeenCalled();
  });
});
