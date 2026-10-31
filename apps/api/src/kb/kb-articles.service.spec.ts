import "reflect-metadata";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { KbArticlesService } from "./kb-articles.service";
import type { KbActor } from "./kb-helpers";

const actor: KbActor = { userId: "staff-1", email: "staff@example.com", context: { ipAddress: null, userAgent: null } };

type Row = Record<string, unknown>;

function makePrisma() {
  const revisions: Row[] = [];
  const prisma = {
    revisions,
    kbArticle: {
      findFirst: mock((_a: unknown) => Promise.resolve(null as Row | null)),
      findUniqueOrThrow: mock((_a: unknown) => Promise.resolve({ id: "a1", status: "published", version: 1 })),
      create: mock((a: { data: Row }) => Promise.resolve({ id: "a-new", slug: a.data.slug, status: "draft", ...a.data })),
      update: mock((a: { data: Row }) => Promise.resolve({ id: "a1", ...a.data })),
      updateMany: mock((_a: unknown) => Promise.resolve({ count: 1 })),
      delete: mock(() => Promise.resolve({})),
    },
    kbArticleRevision: {
      findUnique: mock((a: { where: { articleId_version: { version: number } } }) =>
        Promise.resolve(revisions.find((r) => r.version === a.where.articleId_version.version) ?? null),
      ),
      findFirst: mock((_a: unknown) => Promise.resolve(null as Row | null)),
      create: mock((a: { data: Row }) => {
        revisions.push(a.data);
        return Promise.resolve(a.data);
      }),
    },
    kbAudience: { deleteMany: mock(() => Promise.resolve({})), createMany: mock(() => Promise.resolve({})) },
    kbArticleLabel: { deleteMany: mock(() => Promise.resolve({})), createMany: mock(() => Promise.resolve({})) },
    kbCollection: { findFirst: mock(() => Promise.resolve({ id: "c1" })) },
    member: {
      findFirst: mock(() => Promise.resolve({ id: "m1" })),
      findMany: mock(() => Promise.resolve([])),
    },
    label: { count: mock(() => Promise.resolve(0)) },
    company: { count: mock(() => Promise.resolve(0)) },
    ticket: { findFirst: mock((_a: unknown) => Promise.resolve(null as Row | null)) },
    $transaction: mock((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return prisma;
}

function build() {
  const prisma = makePrisma();
  const audit = { record: mock(() => Promise.resolve()) };
  const settings = { get: mock(() => Promise.resolve({ kbReviewDays: 90 })) };
  const storage = { remove: mock(() => Promise.resolve()), store: mock() };
  const access = { collectionNodes: mock(() => Promise.resolve([])) };
  const service = new KbArticlesService(prisma as never, audit as never, settings as never, storage as never, access as never);
  return { prisma, audit, service, settings };
}

const published = {
  id: "a1",
  organizationId: "org",
  title: "Reset your password",
  slug: "reset-your-password",
  body: "Old body",
  status: "published",
  visibility: "clients",
  collectionId: null,
  reviewBy: null,
  version: 1,
  audiences: [],
  labels: [],
};

describe("KbArticlesService revisions", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it("editing a published article records the old and new versions", async () => {
    ctx.prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published });
    await ctx.service.update("org", "a1", { body: "New body", revisionNote: "Clarified step 2" }, actor);
    expect(ctx.prisma.revisions.map((r) => [r.version, r.body, r.note])).toEqual([
      [1, "Old body", null],
      [2, "New body", "Clarified step 2"],
    ]);
    const update = ctx.prisma.kbArticle.update.mock.calls.at(-1)![0] as { data: Row };
    expect(update.data.version).toBe(2);
    expect(update.data.excerpt).toBe("New body");
  });

  it("does not snapshot the old version twice", async () => {
    ctx.prisma.revisions.push({ version: 1, body: "Old body" });
    ctx.prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published });
    await ctx.service.update("org", "a1", { title: "Reset a password" }, actor);
    expect(ctx.prisma.revisions.map((r) => r.version)).toEqual([1, 2]);
  });

  it("draft edits and metadata-only edits are not versioned", async () => {
    ctx.prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published, status: "draft" });
    await ctx.service.update("org", "a1", { body: "Draft body" }, actor);
    ctx.prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published });
    await ctx.service.update("org", "a1", { body: "Old body", ownerId: "staff-1" }, actor);
    expect(ctx.prisma.revisions).toHaveLength(0);
  });

  it("restoring creates a new revision rather than rewinding", async () => {
    ctx.prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published, version: 3, body: "v3" });
    ctx.prisma.revisions.push({ version: 3, body: "v3" });
    ctx.prisma.kbArticleRevision.findFirst.mockResolvedValueOnce({ id: "r1", version: 1, title: "Old title", body: "v1" });
    const result = (await ctx.service.restore("org", "a1", "r1", actor)) as Row;
    expect(result.version).toBe(4);
    expect(ctx.prisma.revisions.at(-1)).toMatchObject({ version: 4, body: "v1", note: "Restored version 1" });
  });

  it("restore of a revision from another article is not found", async () => {
    ctx.prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published });
    await expect(ctx.service.restore("org", "a1", "nope", actor)).rejects.toThrow(NotFoundException);
  });

  it("changing reviewBy clears the reminder claim", async () => {
    ctx.prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published, reviewBy: new Date("2026-01-01") });
    await ctx.service.update("org", "a1", { reviewBy: "2027-01-01" }, actor);
    const update = ctx.prisma.kbArticle.update.mock.calls.at(-1)![0] as { data: Row };
    expect(update.data.reviewNotifiedAt).toBeNull();
  });

  it("audits a visibility change", async () => {
    ctx.prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published });
    await ctx.service.update("org", "a1", { visibility: "public" }, actor);
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "kb.article_visibility_changed" }));
  });
});

describe("KbArticlesService workflow", () => {
  it("publishing snapshots the version, stamps publishedAt and audits", async () => {
    const { prisma, service, audit } = build();
    prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published, status: "in_review" });
    await service.transition("org", "a1", "publish", actor);
    const call = prisma.kbArticle.updateMany.mock.calls[0][0] as { where: Row; data: Row };
    expect(call.where).toEqual({ id: "a1", status: "in_review" });
    expect(call.data.status).toBe("published");
    expect(call.data.publishedAt).toBeInstanceOf(Date);
    expect(prisma.revisions).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "kb.article_published" }));
  });

  it("a lost race is a conflict", async () => {
    const { prisma, service } = build();
    prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published, status: "draft" });
    prisma.kbArticle.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.transition("org", "a1", "submit", actor)).rejects.toThrow(ConflictException);
  });

  it("invalid transitions are rejected before writing", async () => {
    const { prisma, service } = build();
    prisma.kbArticle.findFirst.mockResolvedValueOnce({ ...published, status: "archived" });
    await expect(service.transition("org", "a1", "publish", actor)).rejects.toThrow(BadRequestException);
    expect(prisma.kbArticle.updateMany).not.toHaveBeenCalled();
  });
});

describe("KbArticlesService.create", () => {
  it("derives slug, excerpt and the default review date", async () => {
    const { prisma, service } = build();
    prisma.kbArticle.findFirst.mockResolvedValueOnce({ id: "taken" }).mockResolvedValueOnce(null);
    const before = Date.now();
    await service.create("org", { title: "Set up VPN", body: "# Steps\n\n**Open** the app" }, actor);
    const data = (prisma.kbArticle.create.mock.calls[0][0] as { data: Row }).data;
    expect(data.slug).toBe("set-up-vpn-2");
    expect(data.excerpt).toBe("Steps Open the app");
    expect(data.ownerId).toBe("staff-1");
    const reviewBy = (data.reviewBy as Date).getTime();
    expect(reviewBy - before).toBeGreaterThanOrEqual(90 * 86400000 - 1000);
  });

  it("rejects an explicit slug that is taken", async () => {
    const { prisma, service } = build();
    prisma.kbArticle.findFirst.mockResolvedValueOnce({ id: "other" });
    await expect(service.create("org", { title: "x", slug: "x" }, actor)).rejects.toThrow(ConflictException);
  });

  it("rejects an owner who is not staff", async () => {
    const { prisma, service } = build();
    prisma.member.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.create("org", { title: "x", ownerId: "client-1" }, actor)).rejects.toThrow(BadRequestException);
  });
});

describe("KbArticlesService.fromTicket", () => {
  it("drafts from public messages only and links the ticket", async () => {
    const { prisma, service } = build();
    prisma.ticket.findFirst.mockResolvedValueOnce({
      id: "t1",
      subject: "Email not syncing on phone",
      status: "resolved",
      messages: [
        { visibility: "public", body: "My mail stopped syncing. Reach me at pat@example.com", source: "portal", authorUserId: "c1", createdAt: new Date(1) },
        { visibility: "internal", body: "Client account flagged for billing", source: "staff", authorUserId: "s1", createdAt: new Date(2) },
        { visibility: "public", body: "Remove and re-add the account in the mail app.", source: "staff", authorUserId: "s1", createdAt: new Date(3) },
      ],
    });
    await service.fromTicket("org", "t1", actor);
    const where = (prisma.ticket.findFirst.mock.calls[0][0] as { where: Row }).where;
    expect(where).toEqual({ id: "t1", organizationId: "org" });
    const data = (prisma.kbArticle.create.mock.calls[0][0] as { data: Row }).data;
    expect(data.title).toBe("Email not syncing on phone");
    expect(data.sourceTicketId).toBe("t1");
    expect(data.status).toBeUndefined();
    expect(data.body).toContain("re-add the account");
    expect(data.body).not.toContain("billing");
    expect(data.body).not.toContain("pat@example.com");
  });

  it("refuses unresolved tickets and tickets of other workspaces", async () => {
    const { prisma, service } = build();
    prisma.ticket.findFirst.mockResolvedValueOnce({ id: "t1", subject: "x", status: "open", messages: [] });
    await expect(service.fromTicket("org", "t1", actor)).rejects.toThrow(BadRequestException);
    await expect(service.fromTicket("org", "t2", actor)).rejects.toThrow(NotFoundException);
  });
});
