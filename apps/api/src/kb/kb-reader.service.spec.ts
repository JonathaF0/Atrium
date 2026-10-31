import "reflect-metadata";
import { describe, expect, it, mock } from "bun:test";
import { NotFoundException } from "@nestjs/common";
import { KbReaderService } from "./kb-reader.service";
import { buildArticleFilter } from "./kb-visibility";
import type { KbReader } from "./kb-visibility";

type Row = Record<string, unknown>;
const CLIENT: KbReader = { kind: "client", companyId: "co-a" };

function build() {
  const prisma = {
    kbArticle: {
      findFirst: mock((_a: unknown) => Promise.resolve({ id: "a1" } as Row | null)),
      findMany: mock((_a: unknown) => Promise.resolve([] as Row[])),
      update: mock((_a: unknown) => Promise.resolve({})),
      findUniqueOrThrow: mock(() => Promise.resolve({ helpfulYes: 1, helpfulNo: 0 })),
    },
    kbFeedback: {
      findUnique: mock((_a: unknown) => Promise.resolve(null as Row | null)),
      create: mock((_a: unknown) => Promise.resolve({})),
      update: mock((_a: unknown) => Promise.resolve({})),
    },
    kbDeflection: { create: mock((_a: unknown) => Promise.resolve({})) },
    $queryRaw: mock((_q: unknown) => Promise.resolve([] as Row[])),
    $transaction: mock((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const access = {
    filter: mock((orgId: string, reader: KbReader, opts: { publishedOnly?: boolean } = {}) =>
      Promise.resolve({ filter: buildArticleFilter(orgId, reader, [], opts), collections: [] }),
    ),
  };
  return { prisma, access, service: new KbReaderService(prisma as never, access as never) };
}

describe("KbReaderService.feedback", () => {
  it("a first vote creates feedback and increments one counter", async () => {
    const { prisma, service } = build();
    await service.feedback("org", CLIENT, "slug", { userId: "u1", key: "u1" }, { helpful: true });
    expect(prisma.kbFeedback.create).toHaveBeenCalled();
    expect(prisma.kbArticle.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { helpfulYes: { increment: 1 } } });
  });

  it("changing a vote moves the counters", async () => {
    const { prisma, service } = build();
    prisma.kbFeedback.findUnique.mockResolvedValueOnce({ id: "f1", helpful: true });
    await service.feedback("org", CLIENT, "slug", { userId: "u1", key: "u1" }, { helpful: false });
    expect(prisma.kbArticle.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { helpfulNo: { increment: 1 }, helpfulYes: { decrement: 1 } },
    });
  });

  it("repeating the same vote leaves counters alone", async () => {
    const { prisma, service } = build();
    prisma.kbFeedback.findUnique.mockResolvedValueOnce({ id: "f1", helpful: true });
    await service.feedback("org", CLIENT, "slug", { userId: "u1", key: "u1" }, { helpful: true });
    expect(prisma.kbArticle.update).not.toHaveBeenCalled();
  });

  it("voting on an article the reader can't see is not found", async () => {
    const { prisma, service } = build();
    prisma.kbArticle.findFirst.mockResolvedValueOnce(null);
    await expect(service.feedback("org", CLIENT, "secret", { userId: "u1", key: "u1" }, { helpful: true })).rejects.toThrow(
      NotFoundException,
    );
    const where = (prisma.kbArticle.findFirst.mock.calls[0][0] as { where: { AND: Row[] } }).where;
    expect(where.AND[0]).toMatchObject({ organizationId: "org", status: "published" });
  });
});

describe("KbReaderService.getArticle", () => {
  it("counts a reader's view once per day", async () => {
    const { prisma, service } = build();
    const row = { id: "a1", labels: [], attachments: [] };
    prisma.kbArticle.findFirst.mockResolvedValue(row);
    await service.getArticle("org", CLIENT, "slug", { userId: "u1", key: "u1" });
    await service.getArticle("org", CLIENT, "slug", { userId: "u1", key: "u1" });
    await service.getArticle("org", CLIENT, "slug", { userId: "u2", key: "u2" });
    expect(prisma.kbArticle.update).toHaveBeenCalledTimes(2);
  });

  it("applies the reader filter to the slug lookup", async () => {
    const { prisma, service } = build();
    prisma.kbArticle.findFirst.mockResolvedValueOnce(null);
    await expect(service.getArticle("org", { kind: "anonymous" }, "x", null)).rejects.toThrow(NotFoundException);
    const where = (prisma.kbArticle.findFirst.mock.calls[0][0] as { where: { AND: Row[] } }).where;
    expect(JSON.stringify(where.AND[0])).toContain(`"in":["public"]`);
    expect(where.AND[1]).toEqual({ slug: "x" });
  });
});

describe("KbReaderService.recordDeflection", () => {
  it("only records outcomes for visible articles", async () => {
    const { prisma, service } = build();
    prisma.kbArticle.findFirst.mockResolvedValueOnce(null);
    await expect(service.recordDeflection("org", CLIENT, "u1", "hidden", "viewed")).rejects.toThrow(NotFoundException);
    expect(prisma.kbDeflection.create).not.toHaveBeenCalled();
    await service.recordDeflection("org", CLIENT, "u1", "a1", "deflected");
    expect(prisma.kbDeflection.create).toHaveBeenCalledWith({ data: { articleId: "a1", userId: "u1", outcome: "deflected" } });
  });
});

describe("KbReaderService.search", () => {
  it("hydrates hits in rank order through the reader filter", async () => {
    const { prisma, service } = build();
    prisma.$queryRaw.mockResolvedValueOnce([{ id: "b" }, { id: "a" }]);
    prisma.kbArticle.findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    const result = await service.search("org", CLIENT, "printer offline", { limit: 2 });
    expect(result.map((r) => r.id)).toEqual(["b", "a"]);
    const where = (prisma.kbArticle.findMany.mock.calls[0][0] as { where: { AND: Row[] } }).where;
    expect(where.AND[0]).toMatchObject({ status: "published" });
  });

  it("tops up with title matches when full-text finds too little", async () => {
    const { prisma, service } = build();
    await service.search("org", CLIENT, "vp");
    // Short query: no full-text query, one title query.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("suggest ignores very short subjects", async () => {
    const { prisma, service } = build();
    expect(await service.suggest("org", CLIENT, "hi")).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
