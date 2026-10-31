import { Prisma } from "@atrium/database";

/** Must match the expression of the GIN index kb_article_fts_idx exactly, or Postgres can't use it. */
export const KB_FTS_DOCUMENT = Prisma.sql`to_tsvector('simple', coalesce(a."title", '') || ' ' || coalesce(a."body", ''))`;

export const MAX_QUERY_LENGTH = 200;

/** Queries this short rarely form a useful full-text term; title trigram matching handles them. */
export const SHORT_QUERY_LENGTH = 3;

// The 'simple' configuration has no stop words; for "any term" matching drop the commonest ones.
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "can", "cant", "not", "how", "what", "why",
  "when", "where", "are", "was", "has", "have", "you", "your", "our", "but", "into", "out", "get",
  "does", "doesnt", "dont", "won", "wont", "isnt", "its", "any", "all", "use", "using", "help",
  "to", "of", "in", "on", "is", "it", "my", "me", "we", "an", "or", "at", "be", "do", "no", "so",
  "up", "if", "as", "by", "am", "i",
]);

export function normalizeQuery(q: string | undefined | null): string {
  return (q ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/** Lowercased word tokens (letters and digits only), so they are safe inside to_tsquery. */
export function queryTokens(q: string): string[] {
  return (normalizeQuery(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
}

/**
 * A to_tsquery expression for "match any meaningful word" (used for ticket
 * subject suggestions, where a subject is a sentence rather than a search).
 * The last word gets a prefix match so a half-typed word still counts.
 * Returns null when no usable word remains.
 */
export function buildAnyTermTsQuery(q: string): string | null {
  const tokens: string[] = [...new Set(queryTokens(q).map((t) => t.replace(/'/g, "")))].filter(
    (t) => t.length >= 2 && !STOP_WORDS.has(t),
  );
  if (tokens.length === 0) return null;
  const last: number = tokens.length - 1;
  return tokens.map((t, i) => (i === last && t.length >= 3 ? `${t}:*` : t)).join(" | ");
}

/** Escapes LIKE wildcards so user text matches literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface KbSearchPlan {
  /** Full-text query, or null when the input is too short to be worth it. */
  fts: Prisma.Sql | null;
  /** Title trigram/substring fallback. */
  titleLike: string;
}

/**
 * Decides how a search runs: websearch syntax (quotes, -exclusions, "or") for
 * the search box, any-term matching for suggestions, and a title substring
 * fallback that catches short queries and partial words.
 */
export function planSearch(q: string, mode: "search" | "suggest"): KbSearchPlan | null {
  const text: string = normalizeQuery(q);
  if (!text) return null;
  let fts: Prisma.Sql | null = null;
  if (mode === "search") {
    if (text.length >= SHORT_QUERY_LENGTH) fts = Prisma.sql`websearch_to_tsquery('simple', ${text})`;
  } else {
    const any: string | null = buildAnyTermTsQuery(text);
    if (any) fts = Prisma.sql`to_tsquery('simple', ${any})`;
  }
  return { fts, titleLike: likePattern(text) };
}

/** Ranked full-text query over articles the filter allows. Returns ids with their rank. */
export function ftsQuery(plan: KbSearchPlan, filter: Prisma.Sql, limit: number): Prisma.Sql | null {
  if (!plan.fts) return null;
  return Prisma.sql`
    SELECT a."id", ts_rank(${KB_FTS_DOCUMENT}, q.query) AS rank
    FROM "kb_article" a, ${plan.fts} AS q(query)
    WHERE ${filter} AND ${KB_FTS_DOCUMENT} @@ q.query
    ORDER BY rank DESC, a."updatedAt" DESC
    LIMIT ${limit}`;
}

/** Title substring match (served by the kb_article_title_trgm_idx trigram index). */
export function titleQuery(plan: KbSearchPlan, filter: Prisma.Sql, limit: number, excludeIds: string[]): Prisma.Sql {
  const exclude: Prisma.Sql =
    excludeIds.length > 0 ? Prisma.sql`AND a."id" NOT IN (${Prisma.join(excludeIds)})` : Prisma.empty;
  return Prisma.sql`
    SELECT a."id", 0::real AS rank
    FROM "kb_article" a
    WHERE ${filter} AND a."title" ILIKE ${plan.titleLike} ${exclude}
    ORDER BY a."viewCount" DESC, a."updatedAt" DESC
    LIMIT ${limit}`;
}
