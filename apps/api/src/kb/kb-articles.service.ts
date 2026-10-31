import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import {
  AttachmentStorageService,
  AuditService,
  ServiceSettingsService,
  excerpt,
  normalizeMarkdown,
  slugify,
} from "../service-core";
import { paginatedResponse, paginationArgs } from "../common";
import type { TempUploadedFile } from "../files/files.service";
import { CreateKbArticleDto, ListKbArticlesQueryDto, UpdateKbArticleDto } from "./kb.dto";
import { contentChanged, isVersionedStatus, nextStatus } from "./kb-workflow";
import type { KbWorkflowAction } from "./kb-workflow";
import { draftFromTicket } from "./kb-from-ticket";
import { effectiveVisibility } from "./kb-visibility";
import { KbAccessService } from "./kb-access.service";
import { addDays, assertCompaniesInOrg, availableSlug, sameIds } from "./kb-helpers";
import type { KbActor } from "./kb-helpers";

const LIST_SELECT = {
  id: true,
  title: true,
  slug: true,
  excerpt: true,
  status: true,
  visibility: true,
  collectionId: true,
  ownerId: true,
  reviewBy: true,
  version: true,
  viewCount: true,
  helpfulYes: true,
  helpfulNo: true,
  publishedAt: true,
  updatedAt: true,
  collection: { select: { id: true, name: true } },
} as const;

const AUDITED_TRANSITIONS: Partial<Record<KbWorkflowAction, { action: string; verb: string }>> = {
  publish: { action: "kb.article_published", verb: "Published" },
  unpublish: { action: "kb.article_unpublished", verb: "Moved to draft" },
  archive: { action: "kb.article_archived", verb: "Archived" },
};

type Tx = Prisma.TransactionClient;

@Injectable()
export class KbArticlesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private settings: ServiceSettingsService,
    private storage: AttachmentStorageService,
    private access: KbAccessService,
  ) {}

  async list(organizationId: string, query: ListKbArticlesQueryDto, now: Date = new Date()) {
    const page: number = query.page ?? 1;
    const limit: number = query.limit ?? 20;
    const where: Prisma.KbArticleWhereInput = { organizationId };
    if (query.status) where.status = query.status;
    if (query.visibility) where.visibility = query.visibility;
    if (query.ownerId) where.ownerId = query.ownerId;
    if (query.collectionId) where.collectionId = query.collectionId;
    if (query.review === "stale") {
      where.reviewBy = { lte: now };
      where.status = query.status ?? { not: "archived" };
    } else if (query.review === "upcoming") {
      where.reviewBy = { gt: now, lte: addDays(now, 30) };
    }
    if (query.q?.trim()) where.title = { contains: query.q.trim(), mode: "insensitive" };

    const [rows, total] = await Promise.all([
      this.prisma.kbArticle.findMany({
        where,
        select: LIST_SELECT,
        orderBy: { updatedAt: "desc" },
        ...paginationArgs(page, limit),
      }),
      this.prisma.kbArticle.count({ where }),
    ]);
    const owners = await this.ownerNames(organizationId, rows.map((r) => r.ownerId));
    return paginatedResponse(
      rows.map((r) => ({ ...r, owner: r.ownerId ? owners.get(r.ownerId) ?? null : null })),
      total,
      page,
      limit,
    );
  }

  async get(organizationId: string, id: string) {
    const article = await this.prisma.kbArticle.findFirst({
      where: { id, organizationId },
      include: {
        collection: { select: { id: true, name: true } },
        audiences: { select: { company: { select: { id: true, name: true } } } },
        labels: { select: { label: { select: { id: true, name: true, color: true } } } },
        attachments: {
          select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
        _count: { select: { revisions: true } },
      },
    });
    if (!article) throw new NotFoundException("Article not found");
    const collections = await this.access.collectionNodes(organizationId);
    const { audiences, labels, _count, ...rest } = article;
    const owners = await this.ownerNames(organizationId, [article.ownerId]);
    return {
      ...rest,
      audiences: audiences.map((a) => a.company),
      labels: labels.map((l) => l.label),
      revisionCount: _count.revisions,
      owner: article.ownerId ? owners.get(article.ownerId) ?? null : null,
      effectiveVisibility: effectiveVisibility(
        article.visibility,
        article.collectionId,
        new Map(collections.map((c) => [c.id, c])),
      ),
    };
  }

  /** Owners and admins who can own an article. */
  async staff(organizationId: string) {
    const members = await this.prisma.member.findMany({
      where: { organizationId, role: { in: ["owner", "admin"] } },
      select: { userId: true, user: { select: { name: true, email: true } } },
    });
    return members.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email }));
  }

  async create(organizationId: string, dto: CreateKbArticleDto, actor: KbActor, sourceTicketId?: string) {
    const body: string = normalizeMarkdown(dto.body ?? "");
    await this.assertRefs(organizationId, dto);
    const settings = await this.settings.get(organizationId);
    const slug: string = await this.slugFor(organizationId, dto.slug, dto.title);
    const audience: string[] = [...new Set(dto.audienceCompanyIds ?? [])];
    const labelIds: string[] = [...new Set(dto.labelIds ?? [])];
    return this.prisma.kbArticle.create({
      data: {
        organizationId,
        title: dto.title.trim(),
        slug,
        body,
        excerpt: excerpt(body) || null,
        collectionId: dto.collectionId ?? null,
        visibility: dto.visibility ?? "clients",
        ownerId: dto.ownerId === undefined ? actor.userId : dto.ownerId,
        reviewBy: dto.reviewBy ? new Date(dto.reviewBy) : addDays(new Date(), settings.kbReviewDays),
        sourceTicketId: sourceTicketId ?? null,
        audiences: { create: audience.map((companyId) => ({ companyId })) },
        labels: { create: labelIds.map((labelId) => ({ labelId })) },
      },
      select: { id: true, slug: true, status: true },
    });
  }

  /**
   * Saves changes. A content change to a published or in-review article bumps
   * the version and records a revision, so readers' history is never lost.
   */
  async update(organizationId: string, id: string, dto: UpdateKbArticleDto, actor: KbActor) {
    const existing = await this.prisma.kbArticle.findFirst({
      where: { id, organizationId },
      include: { audiences: { select: { companyId: true } }, labels: { select: { labelId: true } } },
    });
    if (!existing) throw new NotFoundException("Article not found");
    await this.assertRefs(organizationId, dto);

    const data: Prisma.KbArticleUncheckedUpdateInput = {};
    const title: string | undefined = dto.title?.trim();
    const body: string | undefined = dto.body !== undefined ? normalizeMarkdown(dto.body) : undefined;
    if (title !== undefined) data.title = title;
    if (body !== undefined) {
      data.body = body;
      data.excerpt = excerpt(body) || null;
    }
    if (dto.slug !== undefined && dto.slug !== existing.slug) {
      data.slug = await this.slugFor(organizationId, dto.slug, existing.title, id);
    }
    if (dto.collectionId !== undefined) data.collectionId = dto.collectionId;
    if (dto.visibility !== undefined) data.visibility = dto.visibility;
    if (dto.ownerId !== undefined) data.ownerId = dto.ownerId;
    if (dto.reviewBy !== undefined) {
      const reviewBy: Date | null = dto.reviewBy ? new Date(dto.reviewBy) : null;
      if ((reviewBy?.getTime() ?? null) !== (existing.reviewBy?.getTime() ?? null)) {
        data.reviewBy = reviewBy;
        data.reviewNotifiedAt = null;
      }
    }

    const versioned: boolean = isVersionedStatus(existing.status) && contentChanged(existing, { title, body });
    if (versioned) data.version = existing.version + 1;

    const beforeAudience: string[] = existing.audiences.map((a) => a.companyId);
    const audience: string[] | undefined = dto.audienceCompanyIds ? [...new Set(dto.audienceCompanyIds)] : undefined;
    const audienceChanged: boolean = !!audience && !sameIds(beforeAudience, audience);
    const labelIds: string[] | undefined = dto.labelIds ? [...new Set(dto.labelIds)] : undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (versioned) {
        // Keep the version being replaced if it was never snapshotted (e.g. published before revisions began).
        await this.ensureSnapshot(tx, existing, existing.version, actor.userId, null);
        await tx.kbArticleRevision.create({
          data: {
            articleId: id,
            version: existing.version + 1,
            title: title ?? existing.title,
            body: body ?? existing.body,
            authorId: actor.userId,
            note: dto.revisionNote?.trim() || null,
          },
        });
      }
      if (audience && audienceChanged) {
        await tx.kbAudience.deleteMany({ where: { articleId: id } });
        await tx.kbAudience.createMany({ data: audience.map((companyId) => ({ articleId: id, companyId })) });
      }
      if (labelIds) {
        await tx.kbArticleLabel.deleteMany({ where: { articleId: id, labelId: { notIn: labelIds } } });
        const kept = new Set(existing.labels.map((l) => l.labelId));
        const added: string[] = labelIds.filter((l) => !kept.has(l));
        if (added.length > 0) {
          await tx.kbArticleLabel.createMany({ data: added.map((labelId) => ({ articleId: id, labelId })) });
        }
      }
      return tx.kbArticle.update({ where: { id }, data, select: { id: true, slug: true, status: true, version: true } });
    });

    const visibilityChanged: boolean =
      (dto.visibility !== undefined && dto.visibility !== existing.visibility) ||
      (dto.collectionId !== undefined && dto.collectionId !== existing.collectionId);
    if (visibilityChanged || audienceChanged) {
      await this.audit.record({
        organizationId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: visibilityChanged ? "kb.article_visibility_changed" : "kb.article_audience_changed",
        targetType: "kb_article",
        targetId: id,
        summary: `Changed access to "${title ?? existing.title}"`,
        metadata: {
          visibility: { from: existing.visibility, to: dto.visibility ?? existing.visibility },
          collectionId: { from: existing.collectionId, to: dto.collectionId === undefined ? existing.collectionId : dto.collectionId },
          ...(audienceChanged ? { audienceCompanyIds: { from: beforeAudience, to: audience ?? [] } } : {}),
        },
        ...actor.context,
      });
    }
    return updated;
  }

  async transition(organizationId: string, id: string, action: KbWorkflowAction, actor: KbActor) {
    const existing = await this.prisma.kbArticle.findFirst({ where: { id, organizationId } });
    if (!existing) throw new NotFoundException("Article not found");
    const status = nextStatus(existing.status, action);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (status === "published" || status === "in_review") {
        await this.ensureSnapshot(tx, existing, existing.version, actor.userId, status === "published" ? "Published" : "Submitted for review");
      }
      // A concurrent transition loses: the status must still be what we checked.
      const { count } = await tx.kbArticle.updateMany({
        where: { id, status: existing.status },
        data: {
          status,
          ...(status === "published" ? { publishedAt: new Date() } : {}),
        },
      });
      if (count === 0) throw new ConflictException("The article changed; reload and try again");
      return tx.kbArticle.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, publishedAt: true, version: true } });
    });
    const audited = AUDITED_TRANSITIONS[action];
    if (audited) {
      await this.audit.record({
        organizationId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: audited.action,
        targetType: "kb_article",
        targetId: id,
        summary: `${audited.verb} "${existing.title}"`,
        metadata: { from: existing.status, to: status, visibility: existing.visibility },
        ...actor.context,
      });
    }
    return updated;
  }

  async remove(organizationId: string, id: string, actor: KbActor): Promise<{ ok: true }> {
    const existing = await this.prisma.kbArticle.findFirst({
      where: { id, organizationId },
      select: { id: true, title: true, status: true, attachments: { select: { storageKey: true } } },
    });
    if (!existing) throw new NotFoundException("Article not found");
    await this.prisma.kbArticle.delete({ where: { id } });
    await Promise.all(existing.attachments.map((a) => this.storage.remove(a.storageKey)));
    await this.audit.record({
      organizationId,
      actorId: actor.userId,
      actorEmail: actor.email,
      action: "kb.article_deleted",
      targetType: "kb_article",
      targetId: id,
      summary: `Deleted "${existing.title}" (${existing.status})`,
      ...actor.context,
    });
    return { ok: true };
  }

  async revisions(organizationId: string, id: string) {
    const article = await this.prisma.kbArticle.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!article) throw new NotFoundException("Article not found");
    const rows = await this.prisma.kbArticleRevision.findMany({
      where: { articleId: id },
      orderBy: { version: "desc" },
      select: { id: true, version: true, title: true, body: true, authorId: true, note: true, createdAt: true },
    });
    const authors = await this.ownerNames(organizationId, rows.map((r) => r.authorId), false);
    return rows.map((r) => ({ ...r, author: r.authorId ? authors.get(r.authorId) ?? null : null }));
  }

  /** Puts an old revision's content back. This is itself a new revision; history is append-only. */
  async restore(organizationId: string, id: string, revisionId: string, actor: KbActor, note?: string) {
    const article = await this.prisma.kbArticle.findFirst({ where: { id, organizationId } });
    if (!article) throw new NotFoundException("Article not found");
    const revision = await this.prisma.kbArticleRevision.findFirst({ where: { id: revisionId, articleId: id } });
    if (!revision) throw new NotFoundException("Revision not found");
    return this.prisma.$transaction(async (tx) => {
      await this.ensureSnapshot(tx, article, article.version, actor.userId, null);
      const version: number = article.version + 1;
      await tx.kbArticleRevision.create({
        data: {
          articleId: id,
          version,
          title: revision.title,
          body: revision.body,
          authorId: actor.userId,
          note: note?.trim() || `Restored version ${revision.version}`,
        },
      });
      return tx.kbArticle.update({
        where: { id },
        data: { title: revision.title, body: revision.body, excerpt: excerpt(revision.body) || null, version },
        select: { id: true, version: true, title: true, body: true },
      });
    });
  }

  async addAttachment(organizationId: string, id: string, file: TempUploadedFile, actor: KbActor) {
    const article = await this.prisma.kbArticle.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!article) throw new NotFoundException("Article not found");
    const stored = await this.storage.store(file, organizationId, "kb");
    const row = await this.prisma.kbAttachment.create({
      data: { articleId: id, organizationId, ...stored, uploadedById: actor.userId },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
    return { ...row, url: `/api/kb/attachments/${row.id}` };
  }

  async removeAttachment(organizationId: string, articleId: string, attachmentId: string): Promise<{ ok: true }> {
    const row = await this.prisma.kbAttachment.findFirst({
      where: { id: attachmentId, articleId, organizationId },
      select: { id: true, storageKey: true },
    });
    if (!row) throw new NotFoundException("Attachment not found");
    await this.prisma.kbAttachment.delete({ where: { id: row.id } });
    await this.storage.remove(row.storageKey);
    return { ok: true };
  }

  /** Drafts an article from a resolved ticket's public conversation. */
  async fromTicket(organizationId: string, ticketId: string, actor: KbActor) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, organizationId },
      select: {
        id: true,
        subject: true,
        status: true,
        messages: {
          where: { visibility: "public" },
          select: { visibility: true, body: true, source: true, authorUserId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    if (ticket.status !== "resolved" && ticket.status !== "closed") {
      throw new BadRequestException("Only resolved or closed tickets can become articles");
    }
    const draft = draftFromTicket(ticket.subject, ticket.messages);
    return this.create(
      organizationId,
      { title: draft.title, body: draft.body, visibility: "clients" },
      actor,
      ticket.id,
    );
  }

  async stats(organizationId: string, now: Date = new Date()) {
    const [byStatus, totals, top, deflections, stale] = await Promise.all([
      this.prisma.kbArticle.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
      this.prisma.kbArticle.aggregate({
        where: { organizationId },
        _sum: { viewCount: true, helpfulYes: true, helpfulNo: true },
      }),
      this.prisma.kbArticle.findMany({
        where: { organizationId, status: "published" },
        orderBy: { viewCount: "desc" },
        take: 50,
        select: { id: true, title: true, slug: true, viewCount: true, helpfulYes: true, helpfulNo: true },
      }),
      this.prisma.kbDeflection.groupBy({
        by: ["articleId", "outcome"],
        where: { article: { organizationId } },
        _count: { _all: true },
      }),
      this.prisma.kbArticle.findMany({
        where: { organizationId, status: { not: "archived" }, reviewBy: { lte: now } },
        orderBy: { reviewBy: "asc" },
        take: 100,
        select: { id: true, title: true, status: true, ownerId: true, reviewBy: true },
      }),
    ]);

    const deflectionBy = new Map<string, { viewed: number; deflected: number; submitted: number }>();
    for (const row of deflections) {
      const entry = deflectionBy.get(row.articleId) ?? { viewed: 0, deflected: 0, submitted: 0 };
      if (row.outcome === "viewed" || row.outcome === "deflected" || row.outcome === "submitted") {
        entry[row.outcome] += row._count._all;
      }
      deflectionBy.set(row.articleId, entry);
    }
    const owners = await this.ownerNames(organizationId, stale.map((s) => s.ownerId));
    const totalDeflected: number = [...deflectionBy.values()].reduce((sum, d) => sum + d.deflected, 0);
    return {
      totals: {
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
        views: totals._sum.viewCount ?? 0,
        helpfulYes: totals._sum.helpfulYes ?? 0,
        helpfulNo: totals._sum.helpfulNo ?? 0,
        deflected: totalDeflected,
        stale: stale.length,
      },
      articles: top.map((a) => ({
        ...a,
        deflections: deflectionBy.get(a.id) ?? { viewed: 0, deflected: 0, submitted: 0 },
      })),
      stale: stale.map((s) => ({ ...s, owner: s.ownerId ? owners.get(s.ownerId) ?? null : null })),
    };
  }

  /** Records the given version if it has no revision yet. */
  private async ensureSnapshot(
    tx: Tx,
    article: { id: string; title: string; body: string },
    version: number,
    authorId: string,
    note: string | null,
  ): Promise<void> {
    const exists = await tx.kbArticleRevision.findUnique({
      where: { articleId_version: { articleId: article.id, version } },
      select: { id: true },
    });
    if (exists) return;
    await tx.kbArticleRevision.create({
      data: { articleId: article.id, version, title: article.title, body: article.body, authorId, note },
    });
  }

  private async assertRefs(
    organizationId: string,
    dto: { collectionId?: string | null; ownerId?: string | null; labelIds?: string[]; audienceCompanyIds?: string[] },
  ): Promise<void> {
    if (dto.collectionId) {
      const c = await this.prisma.kbCollection.findFirst({ where: { id: dto.collectionId, organizationId }, select: { id: true } });
      if (!c) throw new BadRequestException("Collection not found");
    }
    if (dto.ownerId) {
      const m = await this.prisma.member.findFirst({
        where: { organizationId, userId: dto.ownerId, role: { in: ["owner", "admin"] } },
        select: { id: true },
      });
      if (!m) throw new BadRequestException("The owner must be a staff member of this workspace");
    }
    if (dto.labelIds && dto.labelIds.length > 0) {
      const ids = [...new Set(dto.labelIds)];
      const count: number = await this.prisma.label.count({ where: { organizationId, id: { in: ids } } });
      if (count !== ids.length) throw new BadRequestException("Unknown label");
    }
    if (dto.audienceCompanyIds) {
      await assertCompaniesInOrg(this.prisma, organizationId, [...new Set(dto.audienceCompanyIds)]);
    }
  }

  private async slugFor(organizationId: string, requested: string | undefined, title: string, excludeId?: string): Promise<string> {
    const taken = async (slug: string): Promise<boolean> =>
      !!(await this.prisma.kbArticle.findFirst({
        where: { organizationId, slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
        select: { id: true },
      }));
    if (requested) {
      if (await taken(requested)) throw new ConflictException("Another article already uses this slug");
      return requested;
    }
    return availableSlug(slugify(title), taken);
  }

  /** Display names for user ids; by default only current staff of the workspace. */
  private async ownerNames(
    organizationId: string,
    ids: Array<string | null>,
    staffOnly: boolean = true,
  ): Promise<Map<string, { id: string; name: string }>> {
    const unique: string[] = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const members = await this.prisma.member.findMany({
      where: {
        organizationId,
        userId: { in: unique },
        ...(staffOnly ? { role: { in: ["owner", "admin"] } } : {}),
      },
      select: { userId: true, user: { select: { name: true } } },
    });
    return new Map(members.map((m) => [m.userId, { id: m.userId, name: m.user.name }]));
  }
}
