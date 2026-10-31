import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { NotFoundException } from "@nestjs/common";
import { assertDisposableDatabase } from "./guard";
import { PrismaService } from "../../src/prisma/prisma.service";
import { TicketsService } from "../../src/helpdesk/tickets.service";
import { SlaService } from "../../src/helpdesk/sla.service";
import { HelpdeskDefaultsService } from "../../src/helpdesk/helpdesk-defaults.service";
import { AutomationService } from "../../src/helpdesk/automation.service";
import { ClientScopeService } from "../../src/service-core/client-scope.service";
import { ServiceSettingsService } from "../../src/service-core/service-settings.service";

let prisma: PrismaService;
let tickets: TicketsService;
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Workspace {
  orgId: string;
  ownerId: string;
  companyId: string;
  otherCompanyId: string;
  clientA: string;
  clientB: string;
  adminOfA: string;
  outsider: string;
}

async function user(id: string): Promise<string> {
  await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, emailVerified: true } });
  return id;
}

async function workspace(tag: string): Promise<Workspace> {
  const orgId = `hd-${tag}-${stamp}`;
  await prisma.organization.create({ data: { id: orgId, name: `Sample ${tag}`, slug: orgId } });
  const ownerId = await user(`${orgId}-owner`);
  await prisma.member.create({ data: { id: `${ownerId}-m`, organizationId: orgId, userId: ownerId, role: "owner" } });
  const company = await prisma.company.create({ data: { organizationId: orgId, name: "Sample Co" } });
  const other = await prisma.company.create({ data: { organizationId: orgId, name: "Other Co" } });
  const client = async (name: string, companyId: string, companyAdmin = false): Promise<string> => {
    const id = await user(`${orgId}-${name}`);
    await prisma.member.create({ data: { id: `${id}-m`, organizationId: orgId, userId: id, role: "member" } });
    await prisma.contact.create({ data: { organizationId: orgId, name, email: `${id}@example.com`, userId: id, companyId, companyAdmin } });
    return id;
  };
  return {
    orgId,
    ownerId,
    companyId: company.id,
    otherCompanyId: other.id,
    clientA: await client("client-a", company.id),
    clientB: await client("client-b", company.id),
    adminOfA: await client("company-admin", company.id, true),
    outsider: await client("outsider", other.id),
  };
}

let ws: Workspace;
let ws2: Workspace;

beforeAll(async () => {
  assertDisposableDatabase();
  prisma = new PrismaService();
  await prisma.$connect();
  const settings = new ServiceSettingsService(prisma);
  const notifications = new Proxy({}, { get: () => mock(() => undefined) });
  const audit = { record: mock(async () => undefined) };
  tickets = new TicketsService(
    prisma,
    settings,
    new ClientScopeService(prisma),
    {} as never,
    audit as never,
    new HelpdeskDefaultsService(prisma),
    new SlaService(prisma),
    notifications as never,
    new AutomationService(prisma, audit as never),
  );
  ws = await workspace("one");
  ws2 = await workspace("two");
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [ws?.orgId, ws2?.orgId].filter(Boolean) as string[] } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: "hd-" }, email: { contains: stamp } } });
  await prisma.$disconnect();
});

describe("ticket numbering", () => {
  it("hands out unique, consecutive numbers under concurrency, per workspace", async () => {
    const created = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        tickets.createForClient(ws.clientA, "member", ws.orgId, { subject: `Concurrent ${i}`, description: "x" }),
      ),
    );
    const numbers = created.map((t) => t.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(15);
    expect(numbers[0]).toBe(1001);
    expect(numbers[14]).toBe(1015);

    const other = await tickets.createForClient(ws2.clientA, "member", ws2.orgId, { subject: "First elsewhere", description: "x" });
    expect(other.number).toBe(1001);
  });

  it("creates workspace defaults and applies the standard SLA", async () => {
    const categories = await prisma.ticketCategory.count({ where: { organizationId: ws.orgId } });
    expect(categories).toBe(7);
    const settings = await prisma.serviceSettings.findUnique({ where: { organizationId: ws.orgId } });
    const policy = await prisma.slaPolicy.findFirst({ where: { organizationId: ws.orgId } });
    expect(settings?.defaultSlaPolicyId).toBe(policy?.id ?? "missing");
    const t = await prisma.ticket.findFirst({ where: { organizationId: ws.orgId } });
    expect(t?.slaPolicyId).toBe(policy?.id ?? "missing");
    expect(t?.firstResponseDueAt).not.toBeNull();
    expect(t?.resolutionDueAt?.getTime()).toBeGreaterThan(t?.firstResponseDueAt?.getTime() ?? 0);
  });
});

describe("portal scoping against the database", () => {
  let ticketA: string;
  let ticketOutsider: string;

  beforeAll(async () => {
    ticketA = (await tickets.createForClient(ws.clientA, "member", ws.orgId, { subject: "Scoped A", description: "secret A" })).id;
    ticketOutsider = (await tickets.createForClient(ws.outsider, "member", ws.orgId, { subject: "Scoped outsider", description: "x" })).id;
    await tickets.reply(ticketA, ws.orgId, { userId: ws.ownerId, name: "Owner" }, { body: "internal only", visibility: "internal" });
  });

  it("a colleague without company admin cannot see the ticket", async () => {
    await expect(tickets.findOneForClient(ticketA, ws.clientB, ws.orgId)).rejects.toBeInstanceOf(NotFoundException);
    const list = await tickets.listForClient(ws.clientB, ws.orgId, { q: "Scoped" });
    expect(list.data.map((t) => t.id)).not.toContain(ticketA);
  });

  it("the company admin sees the company's tickets but not another company's", async () => {
    const list = await tickets.listForClient(ws.adminOfA, ws.orgId, { q: "Scoped" });
    const ids = list.data.map((t) => t.id);
    expect(ids).toContain(ticketA);
    expect(ids).not.toContain(ticketOutsider);
    await expect(tickets.findOneForClient(ticketOutsider, ws.adminOfA, ws.orgId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the requester never receives internal notes", async () => {
    const detail = await tickets.findOneForClient(ticketA, ws.clientA, ws.orgId);
    expect(detail.messages.map((m) => m.body)).toEqual(["secret A"]);
  });

  it("another workspace cannot reach the ticket, as staff or as client", async () => {
    await expect(tickets.findOne(ticketA, ws2.orgId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(tickets.findOneForClient(ticketA, ws2.clientA, ws2.orgId)).rejects.toBeInstanceOf(NotFoundException);
    const queue = await tickets.list(ws2.orgId, ws2.ownerId, { view: "all", q: "Scoped" });
    expect(queue.data).toHaveLength(0);
  });

  it("a client reply on a waiting ticket hands it back to staff and resumes the SLA clock", async () => {
    await tickets.update(ticketA, ws.orgId, { userId: ws.ownerId, name: "Owner" }, { status: "waiting_client" });
    let row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketA } });
    expect(row.slaPausedAt).not.toBeNull();
    expect(row.waitingSince).not.toBeNull();
    await tickets.replyAsClient(ticketA, ws.clientA, ws.orgId, "More detail");
    row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketA } });
    expect(row.status).toBe("open");
    expect(row.slaPausedAt).toBeNull();
    expect(row.waitingSince).toBeNull();
  });
});
