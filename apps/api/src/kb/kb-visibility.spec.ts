import { describe, expect, it } from "bun:test";
import { KB_VISIBILITIES } from "@atrium/shared";
import {
  buildArticleFilter,
  canReadArticle,
  collectionChain,
  effectiveVisibility,
  indexCollections,
  layerAllows,
  stricterVisibility,
  visibleCollectionIds,
} from "./kb-visibility";
import type { KbCollectionNode, KbReader } from "./kb-visibility";

const STAFF: KbReader = { kind: "staff" };
const CLIENT_A: KbReader = { kind: "client", companyId: "co-a" };
const CLIENT_B: KbReader = { kind: "client", companyId: "co-b" };
const CLIENT_NO_COMPANY: KbReader = { kind: "client", companyId: null };
const ANON: KbReader = { kind: "anonymous" };
const READERS: Array<[string, KbReader]> = [
  ["staff", STAFF],
  ["client A", CLIENT_A],
  ["client B", CLIENT_B],
  ["client without company", CLIENT_NO_COMPANY],
  ["anonymous", ANON],
];

function node(id: string, visibility: string, parentId: string | null = null, audience: string[] = []): KbCollectionNode {
  return { id, parentId, visibility, audienceCompanyIds: audience };
}

describe("layerAllows", () => {
  // Expected access per visibility (audience = company A).
  const expected: Record<string, Record<string, boolean>> = {
    public: { staff: true, "client A": true, "client B": true, "client without company": true, anonymous: true },
    clients: { staff: true, "client A": true, "client B": true, "client without company": true, anonymous: false },
    restricted: { staff: true, "client A": true, "client B": false, "client without company": false, anonymous: false },
    internal: { staff: true, "client A": false, "client B": false, "client without company": false, anonymous: false },
  };
  for (const visibility of KB_VISIBILITIES) {
    for (const [name, reader] of READERS) {
      it(`${visibility} → ${name}: ${expected[visibility][name]}`, () => {
        expect(layerAllows(reader, visibility, ["co-a"])).toBe(expected[visibility][name]);
      });
    }
  }

  it("treats an unknown visibility as staff-only", () => {
    expect(layerAllows(CLIENT_A, "everyone", ["co-a"])).toBe(false);
    expect(layerAllows(ANON, "", [])).toBe(false);
    expect(layerAllows(STAFF, "everyone", [])).toBe(true);
  });

  it("restricted with an empty audience admits no client", () => {
    expect(layerAllows(CLIENT_A, "restricted", [])).toBe(false);
  });
});

describe("stricterVisibility / effectiveVisibility", () => {
  it("orders public < clients < restricted < internal", () => {
    expect(stricterVisibility("public", "clients")).toBe("clients");
    expect(stricterVisibility("restricted", "clients")).toBe("restricted");
    expect(stricterVisibility("internal", "public")).toBe("internal");
    expect(stricterVisibility("bogus", "public")).toBe("internal");
  });

  it("takes the strictest of the article and every ancestor collection", () => {
    const byId = indexCollections([node("root", "internal"), node("mid", "clients", "root"), node("leaf", "public", "mid")]);
    expect(effectiveVisibility("public", "leaf", byId)).toBe("internal");
    expect(effectiveVisibility("public", null, byId)).toBe("public");
    expect(effectiveVisibility("restricted", "mid", indexCollections([node("mid", "clients")]))).toBe("restricted");
  });

  it("survives a cycle in parent links", () => {
    const byId = indexCollections([node("x", "public", "y"), node("y", "clients", "x")]);
    expect(collectionChain("x", byId).map((n) => n.id)).toEqual(["x", "y"]);
    expect(effectiveVisibility("public", "x", byId)).toBe("clients");
  });
});

describe("visibleCollectionIds", () => {
  const collections: KbCollectionNode[] = [
    node("pub", "public"),
    node("cli", "clients"),
    node("int", "internal"),
    node("pub-under-int", "public", "int"),
    node("res-a", "restricted", null, ["co-a"]),
    node("cli-under-res-a", "clients", "res-a"),
    node("res-b-under-res-a", "restricted", "res-a", ["co-b"]),
  ];

  it("staff see every collection", () => {
    expect(visibleCollectionIds(collections, STAFF).size).toBe(collections.length);
  });

  it("an ancestor's restriction applies to its descendants", () => {
    expect([...visibleCollectionIds(collections, CLIENT_A)].sort()).toEqual(["cli", "cli-under-res-a", "pub", "res-a"]);
    // Both restricted layers must admit the reader: B is not in res-a's audience.
    expect([...visibleCollectionIds(collections, CLIENT_B)].sort()).toEqual(["cli", "pub"]);
  });

  it("anonymous readers only get fully public chains", () => {
    expect([...visibleCollectionIds(collections, ANON)]).toEqual(["pub"]);
  });
});

describe("canReadArticle", () => {
  const collections: KbCollectionNode[] = [
    node("pub", "public"),
    node("int", "internal"),
    node("res-a", "restricted", null, ["co-a"]),
  ];
  const article = (overrides: Partial<Parameters<typeof canReadArticle>[1]> = {}) => ({
    status: "published",
    visibility: "public",
    collectionId: null,
    audienceCompanyIds: [] as string[],
    ...overrides,
  });

  it("never shows unpublished articles outside staff", () => {
    for (const status of ["draft", "in_review", "archived"]) {
      expect(canReadArticle(CLIENT_A, article({ status }), collections)).toBe(false);
      expect(canReadArticle(ANON, article({ status }), collections)).toBe(false);
      expect(canReadArticle(STAFF, article({ status }), collections)).toBe(true);
      expect(canReadArticle(STAFF, article({ status }), collections, { publishedOnly: true })).toBe(false);
    }
  });

  it("a public article in an internal collection is staff-only", () => {
    const a = article({ collectionId: "int" });
    expect(canReadArticle(CLIENT_A, a, collections)).toBe(false);
    expect(canReadArticle(ANON, a, collections)).toBe(false);
    expect(canReadArticle(STAFF, a, collections)).toBe(true);
  });

  it("a restricted article admits only its audience", () => {
    const a = article({ visibility: "restricted", audienceCompanyIds: ["co-a"] });
    expect(canReadArticle(CLIENT_A, a, collections)).toBe(true);
    expect(canReadArticle(CLIENT_B, a, collections)).toBe(false);
    expect(canReadArticle(CLIENT_NO_COMPANY, a, collections)).toBe(false);
  });

  it("an article in a restricted collection follows the collection's audience", () => {
    const a = article({ visibility: "clients", collectionId: "res-a" });
    expect(canReadArticle(CLIENT_A, a, collections)).toBe(true);
    expect(canReadArticle(CLIENT_B, a, collections)).toBe(false);
  });

  it("an article in an unknown collection is hidden from non-staff", () => {
    expect(canReadArticle(CLIENT_A, article({ collectionId: "gone" }), collections)).toBe(false);
  });
});

describe("buildArticleFilter", () => {
  const collections: KbCollectionNode[] = [node("pub", "public"), node("cli", "clients"), node("int", "internal")];

  it("staff: org only, drafts included unless publishedOnly", () => {
    expect(buildArticleFilter("org", STAFF, collections).where).toEqual({ organizationId: "org" });
    expect(buildArticleFilter("org", STAFF, collections, { publishedOnly: true }).where).toEqual({
      organizationId: "org",
      status: "published",
    });
  });

  it("client: published, own layer and visible collections", () => {
    const { where, sql } = buildArticleFilter("org", CLIENT_A, collections);
    expect(where).toEqual({
      organizationId: "org",
      status: "published",
      AND: [
        {
          OR: [
            { visibility: { in: ["public", "clients"] } },
            { visibility: "restricted", audiences: { some: { companyId: "co-a" } } },
          ],
        },
        { OR: [{ collectionId: null }, { collectionId: { in: ["cli", "pub"] } }] },
      ],
    });
    expect(sql.values).toEqual(["org", "public", "clients", "co-a", "cli", "pub"]);
    expect(sql.sql).toContain(`a."status" = 'published'`);
    expect(sql.sql).toContain(`"kb_audience"`);
  });

  it("client without a company never matches restricted articles", () => {
    const { where, sql } = buildArticleFilter("org", CLIENT_NO_COMPANY, collections);
    expect(JSON.stringify(where)).not.toContain("restricted");
    expect(sql.sql).not.toContain("kb_audience");
  });

  it("anonymous: public only; with no visible collection only uncategorised articles", () => {
    const { where, sql } = buildArticleFilter("org", ANON, [node("int", "internal")]);
    expect(where.AND).toEqual([{ OR: [{ visibility: { in: ["public"] } }] }, { OR: [{ collectionId: null }] }]);
    expect(sql.sql).toContain(`a."collectionId" IS NULL`);
    expect(sql.sql).not.toContain("IN ()");
  });

  it("agrees with canReadArticle over a matrix of articles", () => {
    const cols: KbCollectionNode[] = [
      node("pub", "public"),
      node("cli", "clients"),
      node("int", "internal"),
      node("res-a", "restricted", null, ["co-a"]),
    ];
    const statuses = ["draft", "in_review", "published", "archived"];
    const colIds: Array<string | null> = [null, "pub", "cli", "int", "res-a"];
    for (const [, reader] of READERS) {
      const { where } = buildArticleFilter("org", reader, cols);
      for (const status of statuses) {
        for (const visibility of KB_VISIBILITIES) {
          for (const collectionId of colIds) {
            for (const audience of [[], ["co-a"], ["co-b"]]) {
              const a = { status, visibility, collectionId, audienceCompanyIds: audience };
              expect(matchesWhere(where, a)).toBe(canReadArticle(reader, a, cols));
            }
          }
        }
      }
    }
  });
});

/** A tiny evaluator for the subset of Prisma where-shapes buildArticleFilter emits. */
function matchesWhere(
  where: Record<string, unknown>,
  a: { status: string; visibility: string; collectionId: string | null; audienceCompanyIds: string[] },
): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "organizationId") continue;
    if (key === "AND") {
      if (!(value as Record<string, unknown>[]).every((w) => matchesWhere(w, a))) return false;
    } else if (key === "OR") {
      if (!(value as Record<string, unknown>[]).some((w) => matchesWhere(w, a))) return false;
    } else if (key === "audiences") {
      const companyId = (value as { some: { companyId: string } }).some.companyId;
      if (!a.audienceCompanyIds.includes(companyId)) return false;
    } else {
      const actual = a[key as "status" | "visibility" | "collectionId"];
      if (value !== null && typeof value === "object" && "in" in (value as object)) {
        if (!(value as { in: unknown[] }).in.includes(actual)) return false;
      } else if (actual !== value) {
        return false;
      }
    }
  }
  return true;
}
