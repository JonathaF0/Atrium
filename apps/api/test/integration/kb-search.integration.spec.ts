import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Prisma } from "@atrium/database";
import { assertDisposableDatabase } from "./guard";
import { PrismaService } from "../../src/prisma/prisma.service";
import { KbAccessService } from "../../src/kb/kb-access.service";
import { KbReaderService } from "../../src/kb/kb-reader.service";
import { KB_FTS_DOCUMENT, planSearch } from "../../src/kb/kb-search";
import type { KbReader } from "../../src/kb/kb-visibility";

let prisma: PrismaService;
let reader: KbReaderService;
let access: KbAccessService;
let orgId: string;
let otherOrgId: string;
let companyA: string;
let companyB: string;

const STAFF: KbReader = { kind: "staff" };
const ANON: KbReader = { kind: "anonymous" };
let clientA: KbReader;
let clientB: KbReader;

async function article(
  slug: string,
  title: string,
  body: string,
  opts: { status?: string; visibility?: string; collectionId?: string | null; audience?: string[]; org?: string } = {},
): Promise<string> {
  const row = await prisma.kbArticle.create({
    data: {
      organizationId: opts.org ?? orgId,
      slug,
      title,
      body,
      status: opts.status ?? "published",
      visibility: opts.visibility ?? "clients",
      collectionId: opts.collectionId ?? null,
      audiences: { create: (opts.audience ?? []).map((companyId) => ({ companyId })) },
    },
  });
  return row.id;
}

async function slugs(r: KbReader, q: string, mode: "search" | "suggest" = "search", publishedOnly = true): Promise<string[]> {
  const rows = await reader.search(orgId, r, q, { mode, publishedOnly, limit: 20 });
  return rows.map((a) => a.slug).sort();
}

beforeAll(async () => {
  assertDisposableDatabase();
  prisma = new PrismaService();
  await prisma.$connect();
  // Normally applied by packages/database/scripts/migrate-kb-fts.ts; idempotent.
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS kb_article_fts_idx ON "kb_article" USING GIN (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body", '')))`,
  );
  access = new KbAccessService(prisma, { resolve: async () => ({}) } as never);
  reader = new KbReaderService(prisma, access);

  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({ data: { id: `kb-org-${s}`, name: `kb-${s}`, slug: `kb-${s}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { id: `kb-org2-${s}`, name: `kb2-${s}`, slug: `kb2-${s}` } })).id;
  companyA = (await prisma.company.create({ data: { organizationId: orgId, name: "Company A" } })).id;
  companyB = (await prisma.company.create({ data: { organizationId: orgId, name: "Company B" } })).id;
  clientA = { kind: "client", companyId: companyA };
  clientB = { kind: "client", companyId: companyB };

  const pub = await prisma.kbCollection.create({ data: { organizationId: orgId, name: "Getting started", slug: "start", visibility: "public" } });
  const internal = await prisma.kbCollection.create({ data: { organizationId: orgId, name: "Runbooks", slug: "runbooks", visibility: "internal" } });
  const restrictedA = await prisma.kbCollection.create({
    data: { organizationId: orgId, name: "Company A only", slug: "a-only", visibility: "restricted", audiences: { create: [{ companyId: companyA }] } },
  });
  const nested = await prisma.kbCollection.create({
    data: { organizationId: orgId, name: "Nested public", slug: "nested", visibility: "public", parentId: restrictedA.id },
  });

  await article("printer-offline", "Printer shows offline", "Power cycle the printer and re-add it.", { visibility: "public", collectionId: pub.id });
  await article("printer-drivers", "Install drivers", "Download the printer driver package from the vendor.", { visibility: "clients" });
  await article("printer-internal", "Printer fleet notes", "Printer toner contract details.", { visibility: "internal" });
  await article("printer-runbook", "Printer reset runbook", "Printer reset steps for staff.", { visibility: "public", collectionId: internal.id });
  await article("printer-draft", "Printer draft", "Printer draft body.", { status: "draft", visibility: "public" });
  await article("printer-a", "Printer for company A", "Printer setup at site A.", { visibility: "restricted", audience: [companyA] });
  await article("printer-a-collection", "Printer in A collection", "Printer queue at A.", { visibility: "clients", collectionId: restrictedA.id });
  await article("printer-nested", "Printer nested", "Printer nested under restricted.", { visibility: "public", collectionId: nested.id });
  await article("vpn-setup", "VPN setup", "Install the client and sign in with your account.", { visibility: "public" });
  await article("printer-other-org", "Printer elsewhere", "Printer in another workspace.", { visibility: "public", org: otherOrgId });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  await prisma.$disconnect();
});

describe("knowledge base search against Postgres", () => {
  it("staff see every published match in their own workspace", async () => {
    expect(await slugs(STAFF, "printer")).toEqual([
      "printer-a",
      "printer-a-collection",
      "printer-drivers",
      "printer-internal",
      "printer-nested",
      "printer-offline",
      "printer-runbook",
    ]);
  });

  it("staff search can include drafts", async () => {
    expect(await slugs(STAFF, "printer", "search", false)).toContain("printer-draft");
  });

  it("company A sees public, clients and A-restricted articles", async () => {
    expect(await slugs(clientA, "printer")).toEqual([
      "printer-a",
      "printer-a-collection",
      "printer-drivers",
      "printer-nested",
      "printer-offline",
    ]);
  });

  it("company B sees nothing restricted to A", async () => {
    expect(await slugs(clientB, "printer")).toEqual(["printer-drivers", "printer-offline"]);
  });

  it("anonymous readers see only public articles in public collections", async () => {
    expect(await slugs(ANON, "printer")).toEqual(["printer-offline"]);
  });

  it("ranks title matches above body-only matches", async () => {
    const rows = await reader.search(orgId, clientB, "printer", { limit: 5 });
    expect(rows[0].slug).toBe("printer-offline");
  });

  it("short queries fall back to title matching", async () => {
    expect(await slugs(ANON, "vp")).toEqual(["vpn-setup"]);
  });

  it("suggest matches any meaningful word of a ticket subject", async () => {
    expect(await slugs(clientB, "my printer will not print", "suggest")).toEqual(["printer-drivers", "printer-offline"]);
    expect(await slugs(ANON, "Cannot connect to VPN from home", "suggest")).toEqual(["vpn-setup"]);
  });

  it("websearch syntax excludes terms", async () => {
    expect(await slugs(clientA, "printer -site")).not.toContain("printer-a");
  });

  it("collection counts never include articles the reader can't see", async () => {
    const forB = await reader.listCollections(orgId, clientB);
    expect(forB.collections.map((c) => c.slug)).toEqual(["start"]);
    expect(forB.uncategorizedCount).toBe(2);
    const forA = await reader.listCollections(orgId, clientA);
    expect(forA.collections.map((c) => c.slug).sort()).toEqual(["a-only", "nested", "start"]);
  });

  it("the search expression matches kb_article_fts_idx", async () => {
    // Tiny test tables favour other indexes, so check the match condition on its own.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>(
        Prisma.sql`EXPLAIN SELECT a."id" FROM "kb_article" a WHERE ${KB_FTS_DOCUMENT} @@ ${planSearch("printer", "search")!.fts!}`,
      );
    });
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("kb_article_fts_idx");
  });
});
