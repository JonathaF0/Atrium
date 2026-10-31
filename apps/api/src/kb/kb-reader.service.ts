import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { isPrismaUniqueViolation } from "../common/helpers/prisma-errors";
import { paginatedResponse, paginationArgs } from "../common";
import { KbAccessService } from "./kb-access.service";
import { ftsQuery, normalizeQuery, planSearch, titleQuery } from "./kb-search";
import { KbViewCounter } from "./kb-view-counter";
import { visibleCollectionIds } from "./kb-visibility";
import type { KbReader } from "./kb-visibility";

export const READER_ARTICLE_SELECT = {
  id: true,
  title: true,
  slug: true,
  excerpt: true,
  collectionId: true,
  publishedAt: true,
  updatedAt: true,
} as const;

export type ReaderArticleSummary = Prisma.KbArticleGetPayload<{ select: typeof READER_ARTICLE_SELECT }>;

export const MAX_SUGGESTIONS = 5;

/** Who is voting or viewing: a signed-in user, or a hashed key for anonymous readers. */
export interface KbVoter {
  userId: string | null;
  key: string;
}

/**
 * Everything a reader (portal client, public visitor, or staff reading as a
 * reader) does. Every query goes through KbAccessService.filter, so nothing
 * here can return, count or name an article the reader can't see.
 */
@Injectable()
export class KbReaderService {
  private readonly views = new KbViewCounter();

  constructor(
    private prisma: PrismaService,
    private access: KbAccessService,
  ) {}

  /** Visible collections with the number of visible articles in each. */
  async listCollections(organizationId: string, reader: KbReader) {
    const { filter, collections } = await this.access.filter(organizationId, reader, { publishedOnly: true });
    const allowed: Set<string> | null = reader.kind === "staff" ? null : visibleCollectionIds(collections, reader);
    const [rows, counts] = await Promise.all([
      this.prisma.kbCollection.findMany({
        where: { organizationId, ...(allowed ? { id: { in: [...allowed] } } : {}) },
        select: { id: true, name: true, slug: true, description: true, parentId: true, order: true },
        orderBy: [{ order: "asc" }, { name: "asc" }],
      }),
      this.prisma.kbArticle.groupBy({
        by: ["collectionId"],
        where: filter.where,
        _count: { _all: true },
      }),
    ]);
    const countBy = new Map(counts.map((c) => [c.collectionId, c._count._all]));
    return {
      collections: rows.map((c) => ({
        ...c,
        // A parent the reader can't see is not revealed; the child shows at the top level.
        parentId: c.parentId && (!allowed || allowed.has(c.parentId)) ? c.parentId : null,
        articleCount: countBy.get(c.id) ?? 0,
      })),
      uncategorizedCount: countBy.get(null) ?? 0,
    };
  }

  async listArticles(
    organizationId: string,
    reader: KbReader,
    query: { collectionId?: string; page?: number; limit?: number },
  ) {
    const page: number = query.page ?? 1;
    const limit: number = query.limit ?? 20;
    const { filter } = await this.access.filter(organizationId, reader, { publishedOnly: true });
    const where: Prisma.KbArticleWhereInput = {
      AND: [filter.where, ...(query.collectionId ? [{ collectionId: query.collectionId }] : [])],
    };
    const [data, total] = await Promise.all([
      this.prisma.kbArticle.findMany({
        where,
        select: READER_ARTICLE_SELECT,
        orderBy: [{ viewCount: "desc" }, { title: "asc" }],
        ...paginationArgs(page, limit),
      }),
      this.prisma.kbArticle.count({ where }),
    ]);
    return paginatedResponse(data, total, page, limit);
  }

  /** One article by slug. Counts the view once per reader per day. */
  async getArticle(organizationId: string, reader: KbReader, slug: string, viewer: KbVoter | null) {
    const { filter } = await this.access.filter(organizationId, reader, { publishedOnly: true });
    const article = await this.prisma.kbArticle.findFirst({
      where: { AND: [filter.where, { slug }] },
      select: {
        ...READER_ARTICLE_SELECT,
        body: true,
        viewCount: true,
        helpfulYes: true,
        helpfulNo: true,
        collection: { select: { id: true, name: true, slug: true } },
        labels: { select: { label: { select: { id: true, name: true, color: true } } } },
        attachments: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } },
      },
    });
    if (!article) throw new NotFoundException("Article not found");

    // The collection is only named if the reader can see it (filter guarantees that for non-staff).
    let myVote: boolean | null = null;
    if (viewer) {
      if (this.views.shouldCount(viewer.key, article.id)) {
        await this.prisma.kbArticle.update({
          where: { id: article.id },
          data: { viewCount: { increment: 1 } },
          select: { id: true },
        });
      }
      const vote = await this.prisma.kbFeedback.findUnique({
        where: { articleId_voterKey: { articleId: article.id, voterKey: viewer.key } },
        select: { helpful: true },
      });
      myVote = vote?.helpful ?? null;
    }
    return {
      ...article,
      labels: article.labels.map((l) => l.label),
      myVote,
    };
  }

  /** Articles in the same collection or sharing a label, most viewed first. */
  async related(organizationId: string, reader: KbReader, slug: string, limit: number = 5): Promise<ReaderArticleSummary[]> {
    const { filter } = await this.access.filter(organizationId, reader, { publishedOnly: true });
    const article = await this.prisma.kbArticle.findFirst({
      where: { AND: [filter.where, { slug }] },
      select: { id: true, collectionId: true, labels: { select: { labelId: true } } },
    });
    if (!article) throw new NotFoundException("Article not found");
    const labelIds: string[] = article.labels.map((l) => l.labelId);
    const or: Prisma.KbArticleWhereInput[] = [];
    if (article.collectionId) or.push({ collectionId: article.collectionId });
    if (labelIds.length > 0) or.push({ labels: { some: { labelId: { in: labelIds } } } });
    if (or.length === 0) return [];
    return this.prisma.kbArticle.findMany({
      where: { AND: [filter.where, { id: { not: article.id } }, { OR: or }] },
      select: READER_ARTICLE_SELECT,
      orderBy: [{ viewCount: "desc" }, { updatedAt: "desc" }],
      take: limit,
    });
  }

  /**
   * Full-text search ranked with ts_rank, topped up with title matches so
   * short queries and partial words still find something.
   */
  async search(
    organizationId: string,
    reader: KbReader,
    q: string,
    opts: { limit?: number; mode?: "search" | "suggest"; publishedOnly?: boolean } = {},
  ): Promise<Array<ReaderArticleSummary & { status?: string }>> {
    const limit: number = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const plan = planSearch(q, opts.mode ?? "search");
    if (!plan) return [];
    const publishedOnly: boolean = opts.publishedOnly ?? true;
    const { filter } = await this.access.filter(organizationId, reader, { publishedOnly });

    const hits: Array<{ id: string }> = [];
    const fts = ftsQuery(plan, filter.sql, limit);
    if (fts) hits.push(...(await this.prisma.$queryRaw<Array<{ id: string }>>(fts)));
    if (hits.length < limit && (opts.mode ?? "search") === "search") {
      const excluded: string[] = hits.map((h) => h.id);
      hits.push(
        ...(await this.prisma.$queryRaw<Array<{ id: string }>>(titleQuery(plan, filter.sql, limit - hits.length, excluded))),
      );
    }
    if (hits.length === 0) return [];

    const rows = await this.prisma.kbArticle.findMany({
      // Re-applying the filter keeps hydration honest even if the raw SQL ever drifted.
      where: { AND: [filter.where, { id: { in: hits.map((h) => h.id) } }] },
      select: { ...READER_ARTICLE_SELECT, status: !publishedOnly },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return hits.map((h) => byId.get(h.id)).filter((r): r is NonNullable<typeof r> => !!r);
  }

  /**
   * Articles that might answer a ticket before it is submitted. The subject is
   * matched word by word; if that finds little, the ticket category's name is
   * tried too.
   */
  async suggest(organizationId: string, reader: KbReader, q: string, categoryId?: string): Promise<ReaderArticleSummary[]> {
    const text: string = normalizeQuery(q);
    if (text.length < 3) return [];
    const found = await this.search(organizationId, reader, text, { limit: MAX_SUGGESTIONS, mode: "suggest" });
    if (found.length >= MAX_SUGGESTIONS || !categoryId) return found;
    const category = await this.prisma.ticketCategory.findFirst({
      where: { id: categoryId, organizationId },
      select: { name: true },
    });
    if (!category) return found;
    const more = await this.search(organizationId, reader, category.name, { limit: MAX_SUGGESTIONS, mode: "suggest" });
    const seen = new Set(found.map((a) => a.id));
    return [...found, ...more.filter((a) => !seen.has(a.id))].slice(0, MAX_SUGGESTIONS);
  }

  /** Records a helpful/not helpful vote; one per voter, changing it moves the counters. */
  async feedback(
    organizationId: string,
    reader: KbReader,
    slug: string,
    voter: KbVoter,
    vote: { helpful: boolean; comment?: string },
  ): Promise<{ helpfulYes: number; helpfulNo: number; myVote: boolean }> {
    const { filter } = await this.access.filter(organizationId, reader, { publishedOnly: true });
    const article = await this.prisma.kbArticle.findFirst({ where: { AND: [filter.where, { slug }] }, select: { id: true } });
    if (!article) throw new NotFoundException("Article not found");
    const comment: string | null = vote.comment?.trim() ? vote.comment.trim() : null;

    const apply = () =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.kbFeedback.findUnique({
          where: { articleId_voterKey: { articleId: article.id, voterKey: voter.key } },
          select: { id: true, helpful: true },
        });
        if (!existing) {
          await tx.kbFeedback.create({
            data: { articleId: article.id, userId: voter.userId, voterKey: voter.key, helpful: vote.helpful, comment },
          });
          await tx.kbArticle.update({
            where: { id: article.id },
            data: vote.helpful ? { helpfulYes: { increment: 1 } } : { helpfulNo: { increment: 1 } },
          });
        } else {
          await tx.kbFeedback.update({ where: { id: existing.id }, data: { helpful: vote.helpful, comment } });
          if (existing.helpful !== vote.helpful) {
            await tx.kbArticle.update({
              where: { id: article.id },
              data: vote.helpful
                ? { helpfulYes: { increment: 1 }, helpfulNo: { decrement: 1 } }
                : { helpfulNo: { increment: 1 }, helpfulYes: { decrement: 1 } },
            });
          }
        }
        return tx.kbArticle.findUniqueOrThrow({
          where: { id: article.id },
          select: { helpfulYes: true, helpfulNo: true },
        });
      });

    let counts: { helpfulYes: number; helpfulNo: number };
    try {
      counts = await apply();
    } catch (err) {
      // Two first votes from the same voter raced; the second becomes an update.
      if (!isPrismaUniqueViolation(err)) throw err;
      counts = await apply();
    }
    return { ...counts, myVote: vote.helpful };
  }

  /** Records that a suggested article was opened, or that it answered the question. */
  async recordDeflection(
    organizationId: string,
    reader: KbReader,
    userId: string,
    articleId: string,
    outcome: "viewed" | "deflected",
  ): Promise<{ ok: true }> {
    if (outcome !== "viewed" && outcome !== "deflected") throw new BadRequestException("Invalid outcome");
    const { filter } = await this.access.filter(organizationId, reader, { publishedOnly: true });
    const article = await this.prisma.kbArticle.findFirst({
      where: { AND: [filter.where, { id: articleId }] },
      select: { id: true },
    });
    if (!article) throw new NotFoundException("Article not found");
    await this.prisma.kbDeflection.create({ data: { articleId: article.id, userId, outcome } });
    return { ok: true };
  }

  /** An attachment of an article the reader can see. */
  async attachment(organizationId: string, reader: KbReader, attachmentId: string) {
    const attachment = await this.prisma.kbAttachment.findFirst({
      where: { id: attachmentId, organizationId },
      select: { articleId: true, storageKey: true, filename: true, mimeType: true },
    });
    if (!attachment) throw new NotFoundException("Attachment not found");
    // Staff may open attachments of drafts (the editor previews them).
    const { filter } = await this.access.filter(organizationId, reader, { publishedOnly: reader.kind !== "staff" });
    const visible = await this.prisma.kbArticle.findFirst({
      where: { AND: [filter.where, { id: attachment.articleId }] },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException("Attachment not found");
    return attachment;
  }
}
