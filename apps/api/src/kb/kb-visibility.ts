import { Prisma } from "@atrium/database";
import { KB_VISIBILITIES, type KbVisibility } from "@atrium/shared";

/**
 * Who is reading the knowledge base.
 * - staff: owners/admins; see every article (drafts too, unless `publishedOnly`).
 * - client: a portal user; `companyId` is their contact's company (null if none).
 * - anonymous: a public help center visitor (only when the workspace enables it).
 */
export type KbReader =
  | { kind: "staff" }
  | { kind: "client"; companyId: string | null }
  | { kind: "anonymous" };

export const VISIBILITY_RANK: Record<KbVisibility, number> = {
  public: 0,
  clients: 1,
  restricted: 2,
  internal: 3,
};

/** Unknown values are treated as the strictest level so bad data fails closed. */
export function visibilityRank(visibility: string): number {
  return (KB_VISIBILITIES as readonly string[]).includes(visibility)
    ? VISIBILITY_RANK[visibility as KbVisibility]
    : VISIBILITY_RANK.internal;
}

export function stricterVisibility(a: string, b: string): KbVisibility {
  const rank: number = Math.max(visibilityRank(a), visibilityRank(b));
  return KB_VISIBILITIES[rank];
}

/**
 * Whether one visibility layer (an article, or one collection in its chain)
 * lets the reader through. `restricted` checks that layer's own audience.
 */
export function layerAllows(reader: KbReader, visibility: string, audienceCompanyIds: readonly string[]): boolean {
  if (reader.kind === "staff") return true;
  switch (visibility) {
    case "public":
      return true;
    case "clients":
      return reader.kind === "client";
    case "restricted":
      return reader.kind === "client" && !!reader.companyId && audienceCompanyIds.includes(reader.companyId);
    default:
      return false;
  }
}

export interface KbCollectionNode {
  id: string;
  parentId: string | null;
  visibility: string;
  audienceCompanyIds: string[];
}

/** The collection followed by its ancestors, nearest first. Stops at a missing parent or a cycle. */
export function collectionChain(id: string | null, byId: Map<string, KbCollectionNode>): KbCollectionNode[] {
  const chain: KbCollectionNode[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node: KbCollectionNode | undefined = byId.get(current);
    if (!node) break;
    chain.push(node);
    current = node.parentId;
  }
  return chain;
}

export function indexCollections(collections: readonly KbCollectionNode[]): Map<string, KbCollectionNode> {
  return new Map(collections.map((c) => [c.id, c]));
}

/** The stricter of the article's own visibility and every collection above it. */
export function effectiveVisibility(
  articleVisibility: string,
  collectionId: string | null,
  byId: Map<string, KbCollectionNode>,
): KbVisibility {
  return collectionChain(collectionId, byId).reduce<KbVisibility>(
    (acc, node) => stricterVisibility(acc, node.visibility),
    stricterVisibility(articleVisibility, articleVisibility),
  );
}

/** Collections the reader may open: every collection in the chain must allow them. */
export function visibleCollectionIds(collections: readonly KbCollectionNode[], reader: KbReader): Set<string> {
  const byId = indexCollections(collections);
  const ids = new Set<string>();
  for (const c of collections) {
    if (collectionChain(c.id, byId).every((n) => layerAllows(reader, n.visibility, n.audienceCompanyIds))) {
      ids.add(c.id);
    }
  }
  return ids;
}

export interface KbArticleAccessInput {
  status: string;
  visibility: string;
  collectionId: string | null;
  audienceCompanyIds: string[];
}

/** Single-article check; must agree with {@link buildArticleFilter}. */
export function canReadArticle(
  reader: KbReader,
  article: KbArticleAccessInput,
  collections: readonly KbCollectionNode[],
  opts: { publishedOnly?: boolean } = {},
): boolean {
  const publishedOnly: boolean = reader.kind !== "staff" || !!opts.publishedOnly;
  if (publishedOnly && article.status !== "published") return false;
  if (reader.kind === "staff") return true;
  if (!layerAllows(reader, article.visibility, article.audienceCompanyIds)) return false;
  if (!article.collectionId) return true;
  return visibleCollectionIds(collections, reader).has(article.collectionId);
}

export interface KbArticleFilter {
  where: Prisma.KbArticleWhereInput;
  /** Same rules as `where`, for raw queries against `kb_article` aliased as `a`. */
  sql: Prisma.Sql;
}

/**
 * The one place that decides which articles a reader can see. Every reader
 * path (list, get, search, suggest, related, counts, MCP) goes through this,
 * in Prisma form or as SQL for full-text search.
 */
export function buildArticleFilter(
  organizationId: string,
  reader: KbReader,
  collections: readonly KbCollectionNode[],
  opts: { publishedOnly?: boolean } = {},
): KbArticleFilter {
  const publishedOnly: boolean = reader.kind !== "staff" || !!opts.publishedOnly;
  const where: Prisma.KbArticleWhereInput = { organizationId };
  const sqlParts: Prisma.Sql[] = [Prisma.sql`a."organizationId" = ${organizationId}`];

  if (publishedOnly) {
    where.status = "published";
    sqlParts.push(Prisma.sql`a."status" = 'published'`);
  }
  if (reader.kind === "staff") {
    return { where, sql: Prisma.join(sqlParts, " AND ") };
  }

  // The article's own layer.
  const open: string[] = reader.kind === "client" ? ["public", "clients"] : ["public"];
  const ownOr: Prisma.KbArticleWhereInput[] = [{ visibility: { in: open } }];
  const ownSql: Prisma.Sql[] = [Prisma.sql`a."visibility" IN (${Prisma.join(open)})`];
  if (reader.kind === "client" && reader.companyId) {
    ownOr.push({ visibility: "restricted", audiences: { some: { companyId: reader.companyId } } });
    ownSql.push(
      Prisma.sql`(a."visibility" = 'restricted' AND EXISTS (SELECT 1 FROM "kb_audience" au WHERE au."articleId" = a."id" AND au."companyId" = ${reader.companyId}))`,
    );
  }

  // The collection chain, resolved in memory (collections are few per workspace).
  const ids: string[] = [...visibleCollectionIds(collections, reader)].sort();
  const collectionOr: Prisma.KbArticleWhereInput[] = [{ collectionId: null }];
  let collectionSql: Prisma.Sql = Prisma.sql`a."collectionId" IS NULL`;
  if (ids.length > 0) {
    collectionOr.push({ collectionId: { in: ids } });
    collectionSql = Prisma.sql`(a."collectionId" IS NULL OR a."collectionId" IN (${Prisma.join(ids)}))`;
  }

  where.AND = [{ OR: ownOr }, { OR: collectionOr }];
  sqlParts.push(Prisma.sql`(${Prisma.join(ownSql, " OR ")})`, collectionSql);
  return { where, sql: Prisma.join(sqlParts, " AND ") };
}
