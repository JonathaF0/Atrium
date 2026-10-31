import { describe, expect, it } from "bun:test";
import { Prisma } from "@atrium/database";
import {
  KB_FTS_DOCUMENT,
  buildAnyTermTsQuery,
  ftsQuery,
  likePattern,
  normalizeQuery,
  planSearch,
  queryTokens,
  titleQuery,
} from "./kb-search";

describe("kb search query building", () => {
  it("uses exactly the indexed expression", () => {
    expect(KB_FTS_DOCUMENT.sql).toBe(`to_tsvector('simple', coalesce(a."title", '') || ' ' || coalesce(a."body", ''))`);
  });

  it("normalises whitespace and caps length", () => {
    expect(normalizeQuery("  reset   my\npassword ")).toBe("reset my password");
    expect(normalizeQuery("x".repeat(500))).toHaveLength(200);
    expect(normalizeQuery(undefined)).toBe("");
  });

  it("tokenises to letters and digits only", () => {
    expect(queryTokens("VPN: can't connect (error 809)!")).toEqual(["vpn", "can", "t", "connect", "error", "809"]);
    expect(queryTokens("'); DROP TABLE x; --")).toEqual(["drop", "table", "x"]);
  });

  it("any-term tsquery drops stop words and prefixes the last word", () => {
    expect(buildAnyTermTsQuery("Can't connect to the VPN from home")).toBe("connect | vpn | home:*");
    expect(buildAnyTermTsQuery("printer offl")).toBe("printer | offl:*");
    expect(buildAnyTermTsQuery("the and")).toBeNull();
    expect(buildAnyTermTsQuery("!!!")).toBeNull();
  });

  it("escapes LIKE wildcards", () => {
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });

  it("search mode uses websearch_to_tsquery with the text as a bound parameter", () => {
    const plan = planSearch("reset password", "search")!;
    expect(plan.fts!.sql).toBe("websearch_to_tsquery('simple', ?)");
    expect(plan.fts!.values).toEqual(["reset password"]);
    expect(plan.titleLike).toBe("%reset password%");
  });

  it("short queries skip full-text and rely on the title fallback", () => {
    const plan = planSearch("vp", "search")!;
    expect(plan.fts).toBeNull();
    expect(plan.titleLike).toBe("%vp%");
    expect(planSearch("   ", "search")).toBeNull();
  });

  it("suggest mode uses to_tsquery over sanitised terms", () => {
    const plan = planSearch("Outlook keeps asking for password", "suggest")!;
    expect(plan.fts!.sql).toBe("to_tsquery('simple', ?)");
    expect(plan.fts!.values).toEqual(["outlook | keeps | asking | password:*"]);
  });

  it("ranked query applies the visibility filter and ts_rank", () => {
    const filter = Prisma.sql`a."organizationId" = ${"org"}`;
    const sql = ftsQuery(planSearch("printer", "search")!, filter, 10)!;
    expect(sql.sql).toContain("ts_rank(");
    expect(sql.sql).toContain(`a."organizationId" = ?`);
    expect(sql.sql).toContain("@@ q.query");
    expect(sql.values).toEqual(["printer", "org", 10]);
    expect(ftsQuery(planSearch("vp", "search")!, filter, 10)).toBeNull();
  });

  it("title fallback excludes ids already found", () => {
    const filter = Prisma.sql`a."organizationId" = ${"org"}`;
    const sql = titleQuery(planSearch("vpn", "search")!, filter, 5, ["a1", "a2"]);
    expect(sql.sql).toContain(`a."title" ILIKE ?`);
    expect(sql.sql).toContain(`NOT IN (?,?)`);
    expect(sql.values).toEqual(["org", "%vpn%", "a1", "a2", 5]);
    expect(titleQuery(planSearch("vpn", "search")!, filter, 5, []).sql).not.toContain("NOT IN");
  });
});
