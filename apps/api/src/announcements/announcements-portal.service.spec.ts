import { describe, expect, it, mock } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AudienceResolver } from "./audience-resolver.service";
import { AnnouncementsPortalService } from "./announcements-portal.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ClientScopeService } from "../service-core";

const NOW = new Date("2026-10-31T12:00:00Z");
const ORG = "org1";

interface Row {
  id: string;
  organizationId: string;
  type: string;
  severity: string;
  status: string;
  incidentState: string | null;
  audienceType: string;
  audienceValue: string | null;
  audiences: { companyId: string }[];
  windowStart: Date | null;
  windowEnd: Date | null;
  publishedAt: Date | null;
  resolvedAt: Date | null;
  categoryIds: string[];
}

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    organizationId: ORG,
    type: "general",
    severity: "info",
    status: "published",
    incidentState: null,
    audienceType: "all",
    audienceValue: null,
    audiences: [],
    windowStart: null,
    windowEnd: null,
    publishedAt: new Date("2026-10-30T00:00:00Z"),
    resolvedAt: null,
    categoryIds: [],
    ...over,
  };
}

const ANNOUNCEMENTS: Row[] = [
  row("everyone"),
  row("only-a", { audienceType: "companies", audiences: [{ companyId: "A" }] }),
  row("only-b", { audienceType: "companies", audiences: [{ companyId: "B" }] }),
  row("sla", { audienceType: "contracts", audienceValue: "sla" }),
  row("vendor", { audienceType: "assets", audienceValue: "sample vendor" }),
  row("critical", { type: "incident", severity: "critical", incidentState: "investigating", categoryIds: ["cat1"] }),
  row("minor-incident-b", {
    type: "incident",
    severity: "minor",
    incidentState: "identified",
    audienceType: "companies",
    audiences: [{ companyId: "B" }],
    categoryIds: ["cat1"],
  }),
  row("draft-all", { status: "draft" }),
  row("other-org", { organizationId: "org2" }),
];

const CONTACTS: Record<string, { companyId: string | null }> = {
  ua: { companyId: "A" },
  ub: { companyId: "B" },
  unone: { companyId: null },
};

function matchesWhere(r: Row, where: Record<string, unknown>): boolean {
  if (where.organizationId && r.organizationId !== where.organizationId) return false;
  if (where.id && r.id !== where.id) return false;
  const status = where.status as string | { in: string[] } | undefined;
  if (typeof status === "string" && r.status !== status) return false;
  if (status && typeof status === "object" && !status.in.includes(r.status)) return false;
  const type = where.type as string | { in: string[] } | undefined;
  if (typeof type === "string" && r.type !== type) return false;
  if (type && typeof type === "object" && !type.in.includes(r.type)) return false;
  const cats = where.categoryIds as { has: string } | undefined;
  if (cats && !r.categoryIds.includes(cats.has)) return false;
  const or = where.OR as Record<string, unknown>[] | undefined;
  if (or && !or.some((w) => matchesWhere(r, { ...w }))) return false;
  return true;
}

function build() {
  const dismissals: { announcementId: string; userId: string; dismissed: boolean }[] = [];
  const prisma = {
    announcement: {
      findMany: mock(async ({ where }: { where: Record<string, unknown> }) =>
        ANNOUNCEMENTS.filter((r) => matchesWhere(r, where)).map((r) => ({ ...r, updates: [] })),
      ),
      findFirst: mock(async ({ where }: { where: Record<string, unknown> }) => {
        const r = ANNOUNCEMENTS.find((x) => matchesWhere(x, where));
        return r ? { ...r, updates: [] } : null;
      }),
    },
    announcementDismissal: {
      findMany: mock(async ({ where }: { where: { userId: string } }) =>
        dismissals.filter((d) => d.userId === where.userId),
      ),
      upsert: mock(
        async (args: {
          where: { announcementId_userId: { announcementId: string; userId: string } };
          create: { dismissed?: boolean };
          update: { dismissed?: boolean };
        }) => {
          const key = args.where.announcementId_userId;
          const existing = dismissals.find((d) => d.announcementId === key.announcementId && d.userId === key.userId);
          if (existing) {
            if (args.update.dismissed !== undefined) existing.dismissed = args.update.dismissed;
          } else {
            dismissals.push({ ...key, dismissed: args.create.dismissed ?? false });
          }
        },
      ),
    },
    notification: { updateMany: mock(async () => ({ count: 0 })) },
    contract: {
      findMany: mock(async ({ where }: { where: { companyId?: string } }) =>
        where.companyId === "A"
          ? [{ companyId: "A", type: "sla", status: "active", startsAt: new Date("2026-01-01"), endsAt: null, includedServices: [] }]
          : [],
      ),
    },
    asset: {
      findMany: mock(async ({ where }: { where: { companyId?: string } }) =>
        where.companyId === "B" ? [{ companyId: "B", type: "device", vendor: "Sample Vendor", status: "active" }] : [],
      ),
    },
  };
  const clientScope = {
    resolve: async (userId: string, organizationId: string) => ({
      userId,
      organizationId,
      contactId: null,
      companyId: CONTACTS[userId]?.companyId ?? null,
      companyAdmin: false,
      email: null,
      name: null,
    }),
  };
  const resolver = new AudienceResolver(prisma as unknown as PrismaService, clientScope as unknown as ClientScopeService);
  const portal = new AnnouncementsPortalService(prisma as unknown as PrismaService, resolver);
  return { prisma, resolver, portal, dismissals };
}

async function feedIds(userId: string, role = "member"): Promise<string[]> {
  const { resolver, portal } = build();
  const viewer = await resolver.viewer(userId, ORG, role);
  const feed = await portal.feed(viewer, NOW);
  return [...feed.active, ...feed.history].map((a) => a.id).sort();
}

describe("AnnouncementsPortalService audience scoping", () => {
  it("company A sees everyone, its own, its contract audience and the critical incident", async () => {
    expect(await feedIds("ua")).toEqual(["critical", "everyone", "only-a", "sla"]);
  });

  it("company B sees its own targeted items and the vendor audience, nothing of A's", async () => {
    expect(await feedIds("ub")).toEqual(["critical", "everyone", "minor-incident-b", "only-b", "vendor"]);
  });

  it("a portal user without a company only sees announcements for all", async () => {
    expect(await feedIds("unone")).toEqual(["critical", "everyone"]);
  });

  it("owners and admins outside preview see every published announcement of their workspace", async () => {
    const ids = await feedIds("staff", "owner");
    expect(ids).toContain("only-a");
    expect(ids).toContain("only-b");
    expect(ids).not.toContain("draft-all");
    expect(ids).not.toContain("other-org");
  });

  it("unread count only counts what the viewer may see", async () => {
    const { resolver, portal } = build();
    expect(await portal.unreadCount(await resolver.viewer("unone", ORG, "member"), NOW)).toBe(2);
    expect(await portal.unreadCount(await resolver.viewer("ua", ORG, "member"), NOW)).toBe(4);
  });

  it("the category banner respects the audience", async () => {
    const { resolver, portal } = build();
    const a = await portal.forCategory(await resolver.viewer("ua", ORG, "member"), "cat1", NOW);
    const b = await portal.forCategory(await resolver.viewer("ub", ORG, "member"), "cat1", NOW);
    expect(a.map((x) => x.id)).toEqual(["critical"]);
    expect(b.map((x) => x.id).sort()).toEqual(["critical", "minor-incident-b"]);
  });

  it("reading or dismissing an announcement outside the audience is a 404", async () => {
    const { resolver, portal, dismissals } = build();
    const viewer = await resolver.viewer("ua", ORG, "member");
    await expect(portal.markRead(viewer, "only-b", NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(portal.dismiss(viewer, "vendor", NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(portal.markRead(viewer, "draft-all", NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(portal.markRead(viewer, "other-org", NOW)).rejects.toBeInstanceOf(NotFoundException);
    expect(dismissals).toHaveLength(0);
  });
});

describe("AnnouncementsPortalService dismiss and read", () => {
  it("refuses to dismiss a critical incident and keeps it in the banner", async () => {
    const { resolver, portal } = build();
    const viewer = await resolver.viewer("ua", ORG, "member");
    await expect(portal.dismiss(viewer, "critical", NOW)).rejects.toBeInstanceOf(BadRequestException);
    expect((await portal.banner(viewer, NOW)).map((x) => x.id)).toEqual(["critical"]);
  });

  it("dismissing a minor incident hides it from the banner but keeps it in the feed", async () => {
    const { resolver, portal } = build();
    const viewer = await resolver.viewer("ub", ORG, "member");
    expect((await portal.banner(viewer, NOW)).map((x) => x.id).sort()).toEqual(["critical", "minor-incident-b"]);
    await portal.dismiss(viewer, "minor-incident-b", NOW);
    expect((await portal.banner(viewer, NOW)).map((x) => x.id)).toEqual(["critical"]);
    const feed = await portal.feed(viewer, NOW);
    const item = feed.active.find((x) => x.id === "minor-incident-b");
    expect(item?.dismissed).toBe(true);
    expect(item?.read).toBe(true);
  });

  it("marking read lowers the unread count and clears matching bell notifications", async () => {
    const { resolver, portal, prisma } = build();
    const viewer = await resolver.viewer("unone", ORG, "member");
    await portal.markRead(viewer, "everyone", NOW);
    expect(await portal.unreadCount(viewer, NOW)).toBe(1);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: "unone", organizationId: ORG, link: "/portal/announcements?id=everyone", read: false },
      data: { read: true },
    });
  });
});
