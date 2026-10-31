import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { assertDisposableDatabase } from "./guard";
import { PrismaService } from "../../src/prisma/prisma.service";
import { ClientScopeService } from "../../src/service-core";
import { AudienceResolver } from "../../src/announcements/audience-resolver.service";
import { AnnouncementsPortalService } from "../../src/announcements/announcements-portal.service";
import { StatusPageService } from "../../src/announcements/status.controller";
import { PortalHomeService } from "../../src/portal-home/portal-home.service";
import type { ConfigService } from "@nestjs/config";
import type { PinoLogger } from "nestjs-pino";

/**
 * Audience resolution, the portal feed, the public status page and the portal
 * home against real rows. Company A has an active SLA contract and a device from
 * "Sample Vendor"; company B has an expired SLA and a retired device from the
 * same vendor; one client has no company.
 */

const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORG = `ann-org-${s}`;
const OTHER_ORG = `ann-org2-${s}`;
const DAY = 86_400_000;
const now = new Date();

const users = {
  a1: `ann-ua1-${s}`,
  a2: `ann-ua2-${s}`,
  b1: `ann-ub1-${s}`,
  none: `ann-un-${s}`,
  owner: `ann-own-${s}`,
  other: `ann-oth-${s}`,
};

let prisma: PrismaService;
let resolver: AudienceResolver;
let portal: AnnouncementsPortalService;
let status: StatusPageService;
let home: PortalHomeService;
const ids: Record<string, string> = {};

const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
const logger = { warn: () => undefined, error: () => undefined } as unknown as PinoLogger;

async function announce(key: string, data: Record<string, unknown>, companyIds: string[] = []): Promise<void> {
  const a = await prisma.announcement.create({
    data: {
      organizationId: ORG,
      type: "general",
      title: key,
      body: `Body of ${key}`,
      status: "published",
      publishedAt: new Date(now.getTime() - DAY),
      ...data,
      audiences: { create: companyIds.map((companyId) => ({ companyId })) },
    } as Parameters<typeof prisma.announcement.create>[0]["data"],
  });
  ids[key] = a.id;
}

beforeAll(async () => {
  assertDisposableDatabase();
  prisma = new PrismaService();
  await prisma.$connect();
  const scope = new ClientScopeService(prisma);
  resolver = new AudienceResolver(prisma, scope);
  portal = new AnnouncementsPortalService(prisma, resolver);
  status = new StatusPageService(prisma, config);
  home = new PortalHomeService(prisma, config, scope, resolver, portal, logger);

  await prisma.organization.create({ data: { id: ORG, name: `Sample ${s}`, slug: `ann-${s}` } });
  await prisma.organization.create({ data: { id: OTHER_ORG, name: `Other ${s}`, slug: `ann2-${s}` } });
  for (const [key, id] of Object.entries(users)) {
    await prisma.user.create({ data: { id, name: key, email: `${id}@example.com` } });
  }
  const member = (userId: string, role: string, organizationId = ORG) =>
    prisma.member.create({ data: { id: `m-${userId}`, organizationId, userId, role } });
  await member(users.a1, "member");
  await member(users.a2, "member");
  await member(users.b1, "member");
  await member(users.none, "member");
  await member(users.owner, "owner");
  await member(users.other, "member", OTHER_ORG);

  const companyA = await prisma.company.create({ data: { organizationId: ORG, name: "Company A" } });
  const companyB = await prisma.company.create({ data: { organizationId: ORG, name: "Company B" } });
  const companyX = await prisma.company.create({ data: { organizationId: OTHER_ORG, name: "Company X" } });
  ids.A = companyA.id;
  ids.B = companyB.id;
  ids.X = companyX.id;

  await prisma.contact.createMany({
    data: [
      { organizationId: ORG, name: "A1", userId: users.a1, companyId: ids.A, companyAdmin: true },
      { organizationId: ORG, name: "A2", userId: users.a2, companyId: ids.A },
      { organizationId: ORG, name: "B1", userId: users.b1, companyId: ids.B },
      { organizationId: ORG, name: "None", userId: users.none },
      { organizationId: OTHER_ORG, name: "Other", userId: users.other, companyId: ids.X },
    ],
  });

  await prisma.contract.createMany({
    data: [
      { organizationId: ORG, companyId: ids.A, name: "A SLA", type: "sla", status: "active", startsAt: new Date(now.getTime() - 100 * DAY), endsAt: new Date(now.getTime() + 30 * DAY), includedServices: ["backup"] },
      { organizationId: ORG, companyId: ids.B, name: "B SLA", type: "sla", status: "active", startsAt: new Date(now.getTime() - 400 * DAY), endsAt: new Date(now.getTime() - 10 * DAY) },
      { organizationId: OTHER_ORG, companyId: ids.X, name: "X SLA", type: "sla", status: "active", startsAt: new Date(now.getTime() - 10 * DAY) },
    ],
  });
  await prisma.asset.createMany({
    data: [
      { organizationId: ORG, companyId: ids.A, type: "device", name: "Laptop A", vendor: "Sample Vendor", status: "active", warrantyEndsAt: new Date(now.getTime() + 20 * DAY) },
      { organizationId: ORG, companyId: ids.A, type: "domain", name: "Hidden domain", status: "active", renewsAt: new Date(now.getTime() + 10 * DAY), clientVisible: false },
      { organizationId: ORG, companyId: ids.B, type: "device", name: "Old B", vendor: "Sample Vendor", status: "retired", warrantyEndsAt: new Date(now.getTime() + 5 * DAY) },
      { organizationId: ORG, companyId: ids.B, type: "domain", name: "b.example.com", status: "active", renewsAt: new Date(now.getTime() + 90 * DAY) },
    ],
  });

  await announce("all", { audienceType: "all", publicStatus: true, type: "incident", incidentState: "investigating", severity: "major" });
  await announce("onlyA", { audienceType: "companies", type: "maintenance", windowStart: new Date(now.getTime() + DAY), windowEnd: new Date(now.getTime() + DAY + 3_600_000) }, [ids.A]);
  await announce("onlyB", { audienceType: "companies" }, [ids.B]);
  await announce("sla", { audienceType: "contracts", audienceValue: "sla" });
  await announce("backup", { audienceType: "contracts", audienceValue: "backup" });
  await announce("vendor", { audienceType: "assets", audienceValue: "SAMPLE VENDOR" });
  await announce("domain", { audienceType: "assets", audienceValue: "domain" });
  // A public flag on a targeted announcement must never reach the status page.
  await announce("targetedPublic", { audienceType: "companies", publicStatus: true }, [ids.A]);
  await announce("draft", { audienceType: "all", status: "draft", publishedAt: null, publicStatus: true });
  await prisma.announcement.create({
    data: { organizationId: OTHER_ORG, type: "general", title: "other org", body: "x", status: "published", publishedAt: now },
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } }).catch((e: unknown) => console.error(e));
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } }).catch((e: unknown) => console.error(e));
  await prisma?.$disconnect();
});

async function recipients(key: string): Promise<string[]> {
  const a = await prisma.announcement.findUniqueOrThrow({ where: { id: ids[key] }, include: { audiences: true } });
  return (await resolver.recipientUserIds(ORG, a)).sort();
}

async function feedTitles(userId: string, role = "member"): Promise<string[]> {
  const viewer = await resolver.viewer(userId, ORG, role);
  const feed = await portal.feed(viewer);
  return [...feed.active, ...feed.history].map((a) => a.title).sort();
}

describe("AudienceResolver against Postgres", () => {
  it("resolves recipients per audience type, portal users only", async () => {
    expect(await recipients("all")).toEqual([users.a1, users.a2, users.b1, users.none].sort());
    expect(await recipients("onlyA")).toEqual([users.a1, users.a2].sort());
    expect(await recipients("onlyB")).toEqual([users.b1]);
    expect(await recipients("sla")).toEqual([users.a1, users.a2].sort());
    expect(await recipients("backup")).toEqual([users.a1, users.a2].sort());
    expect(await recipients("vendor")).toEqual([users.a1, users.a2].sort());
    expect(await recipients("domain")).toEqual([users.a1, users.a2, users.b1].sort());
  });

  it("the audience preview matches the recipients", async () => {
    expect(await resolver.preview(ORG, { audienceType: "contracts", audienceValue: "sla" })).toEqual({
      companyCount: 1,
      recipientCount: 2,
    });
    expect(await resolver.preview(ORG, { audienceType: "companies", audienceValue: null, audiences: [{ companyId: ids.X }] })).toEqual({
      companyCount: 0,
      recipientCount: 0,
    });
  });

  it("each portal user's feed contains exactly their audience", async () => {
    expect(await feedTitles(users.a1)).toEqual(["all", "backup", "domain", "onlyA", "sla", "targetedPublic", "vendor"]);
    expect(await feedTitles(users.b1)).toEqual(["all", "domain", "onlyB"]);
    expect(await feedTitles(users.none)).toEqual(["all"]);
  });

  it("the banner shows A's maintenance to A only", async () => {
    const a = await portal.banner(await resolver.viewer(users.a2, ORG, "member"));
    const b = await portal.banner(await resolver.viewer(users.b1, ORG, "member"));
    expect(a.map((x) => x.title).sort()).toEqual(["all", "onlyA"]);
    expect(b.map((x) => x.title)).toEqual(["all"]);
  });

  it("reading counts down unread, and B cannot read A's announcement", async () => {
    const viewer = await resolver.viewer(users.b1, ORG, "member");
    const before = await portal.unreadCount(viewer);
    await portal.markRead(viewer, ids.onlyB);
    expect(await portal.unreadCount(viewer)).toBe(before - 1);
    await expect(portal.markRead(viewer, ids.onlyA)).rejects.toThrow();
    const rows = await prisma.announcementDismissal.count({ where: { userId: users.b1, announcementId: ids.onlyA } });
    expect(rows).toBe(0);
  });
});

describe("Public status page against Postgres", () => {
  it("is a 404 while disabled", async () => {
    expect(await status.load(`ann-${s}`)).toBeNull();
  });

  it("shows only public announcements for everyone once enabled", async () => {
    await prisma.serviceSettings.upsert({
      where: { organizationId: ORG },
      create: { organizationId: ORG, statusPageEnabled: true },
      update: { statusPageEnabled: true },
    });
    const loaded = await status.load(`ann-${s}`);
    expect(loaded).not.toBeNull();
    const titles = [...loaded!.page.activeIncidents, ...loaded!.page.maintenance, ...loaded!.page.history].map((i) => i.title);
    expect(titles).toEqual(["all"]);
    expect(status.rss(loaded!.org, loaded!.page)).toContain("<title>all</title>");
    expect(await status.load("no-such-workspace")).toBeNull();
  });
});

describe("Portal home against Postgres", () => {
  beforeAll(async () => {
    const project = await prisma.project.create({ data: { organizationId: ORG, name: "A project" } });
    const projectB = await prisma.project.create({ data: { organizationId: ORG, name: "B project" } });
    await prisma.projectClient.create({ data: { projectId: project.id, userId: users.a1 } });
    await prisma.projectClient.create({ data: { projectId: projectB.id, userId: users.b1 } });
    for (const [n, st, pid] of [
      ["INV-D", "draft", project.id],
      ["INV-S", "sent", project.id],
      ["INV-O", "overdue", project.id],
      ["INV-P", "paid", project.id],
      ["INV-C", "cancelled", project.id],
      ["INV-B", "sent", projectB.id],
    ] as const) {
      await prisma.invoice.create({
        data: { organizationId: ORG, invoiceNumber: `${n}-${s}`, status: st, projectId: pid, type: "uploaded", amount: 1000 },
      });
    }
    await prisma.projectUpdate.create({
      data: { organizationId: ORG, projectId: project.id, authorId: users.owner, content: "Kickoff done" },
    });
    await prisma.projectUpdate.create({
      data: { organizationId: ORG, projectId: projectB.id, authorId: users.owner, content: "B only" },
    });
    let n = 5000;
    const ticket = (requesterUserId: string, companyId: string, statusValue: string, subject: string) =>
      prisma.ticket.create({
        data: {
          organizationId: ORG,
          number: n++,
          subject,
          status: statusValue,
          requesterUserId,
          companyId,
          emailToken: `tok-${s}-${n}`,
        },
      });
    await ticket(users.a1, ids.A, "open", "A1 open");
    await ticket(users.a2, ids.A, "new", "A2 new");
    await ticket(users.a2, ids.A, "closed", "A2 closed");
    await ticket(users.b1, ids.B, "open", "B1 open");
  });

  it("a client sees only their own tickets, invoices and updates", async () => {
    const h = await home.get(users.a2, ORG, "member");
    expect(h.tickets?.latest.map((t) => t.subject)).toEqual(["A2 new"]);
    expect(h.tickets?.openCount).toBe(1);
    // A2 is on no project, so no invoices or updates.
    expect(h.invoices?.latest).toEqual([]);
    expect(h.updates?.latest).toEqual([]);
    expect(h.renewals?.contracts).toBeNull();
    expect(h.renewals?.assets.map((a) => a.name)).toEqual(["Laptop A"]);
  });

  it("a company admin also sees company tickets and contracts; invoices stay sent/overdue only", async () => {
    const h = await home.get(users.a1, ORG, "member");
    expect(h.tickets?.latest.map((t) => t.subject).sort()).toEqual(["A1 open", "A2 new"]);
    expect(h.invoices?.latest.map((i) => i.invoiceNumber.split("-").slice(0, 2).join("-")).sort()).toEqual(["INV-O", "INV-S"]);
    expect(h.invoices?.overdueCount).toBe(1);
    expect(h.updates?.latest.map((u) => u.excerpt)).toEqual(["Kickoff done"]);
    expect(h.renewals?.contracts?.map((c) => c.name)).toEqual(["A SLA"]);
    expect(h.renewals?.assets.map((a) => a.name)).toEqual(["Laptop A"]);
    expect(h.announcements?.banner.map((a) => a.title).sort()).toEqual(["all", "onlyA"]);
  });

  it("company B sees nothing of company A", async () => {
    const h = await home.get(users.b1, ORG, "member");
    expect(h.tickets?.latest.map((t) => t.subject)).toEqual(["B1 open"]);
    expect(h.invoices?.latest.map((i) => i.invoiceNumber.split("-").slice(0, 2).join("-"))).toEqual(["INV-B"]);
    expect(h.updates?.latest.map((u) => u.excerpt)).toEqual(["B only"]);
    expect(h.renewals?.assets).toEqual([]);
    expect(h.company?.name).toBe("Company B");
  });
});
