import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, slugify } from "../service-core";
import { CreateKbCollectionDto, UpdateKbCollectionDto } from "./kb.dto";
import { collectionChain, indexCollections } from "./kb-visibility";
import { availableSlug, assertCompaniesInOrg, sameIds } from "./kb-helpers";
import type { KbActor } from "./kb-helpers";

@Injectable()
export class KbCollectionsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async list(organizationId: string) {
    const rows = await this.prisma.kbCollection.findMany({
      where: { organizationId },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      include: {
        audiences: { select: { companyId: true, company: { select: { id: true, name: true } } } },
        _count: { select: { articles: true, children: true } },
      },
    });
    return rows.map(({ audiences, _count, ...c }) => ({
      ...c,
      audiences: audiences.map((a) => a.company),
      articleCount: _count.articles,
      childCount: _count.children,
    }));
  }

  async create(organizationId: string, dto: CreateKbCollectionDto, actor: KbActor) {
    if (dto.parentId) await this.assertCollection(organizationId, dto.parentId);
    const audience: string[] = [...new Set(dto.audienceCompanyIds ?? [])];
    await assertCompaniesInOrg(this.prisma, organizationId, audience);
    const slug: string = await this.slugFor(organizationId, dto.slug, dto.name);
    const collection = await this.prisma.kbCollection.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        slug,
        description: dto.description?.trim() || null,
        parentId: dto.parentId ?? null,
        order: dto.order ?? 0,
        visibility: dto.visibility ?? "clients",
        audiences: { create: audience.map((companyId) => ({ companyId })) },
      },
    });
    if (collection.visibility !== "clients" || audience.length > 0) {
      await this.audit.record({
        organizationId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: "kb.collection_created",
        targetType: "kb_collection",
        targetId: collection.id,
        summary: `Created collection "${collection.name}" (${collection.visibility})`,
        metadata: { visibility: collection.visibility, audienceCompanyIds: audience },
        ...actor.context,
      });
    }
    return collection;
  }

  async update(organizationId: string, id: string, dto: UpdateKbCollectionDto, actor: KbActor) {
    const existing = await this.prisma.kbCollection.findFirst({
      where: { id, organizationId },
      include: { audiences: { select: { companyId: true } } },
    });
    if (!existing) throw new NotFoundException("Collection not found");

    if (dto.parentId !== undefined && dto.parentId !== existing.parentId && dto.parentId !== null) {
      await this.assertCollection(organizationId, dto.parentId);
      await this.assertNoCycle(organizationId, id, dto.parentId);
    }
    const data: Prisma.KbCollectionUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.order !== undefined) data.order = dto.order;
    if (dto.visibility !== undefined) data.visibility = dto.visibility;
    if (dto.parentId !== undefined) {
      data.parent = dto.parentId ? { connect: { id: dto.parentId } } : { disconnect: true };
    }
    if (dto.slug !== undefined && dto.slug !== existing.slug) {
      data.slug = await this.slugFor(organizationId, dto.slug, existing.name, id);
    }

    const before: string[] = existing.audiences.map((a) => a.companyId);
    const audience: string[] | undefined = dto.audienceCompanyIds ? [...new Set(dto.audienceCompanyIds)] : undefined;
    if (audience) await assertCompaniesInOrg(this.prisma, organizationId, audience);
    const audienceChanged: boolean = !!audience && !sameIds(before, audience);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (audience && audienceChanged) {
        await tx.kbAudience.deleteMany({ where: { collectionId: id } });
        await tx.kbAudience.createMany({ data: audience.map((companyId) => ({ collectionId: id, companyId })) });
      }
      return tx.kbCollection.update({ where: { id }, data });
    });

    const visibilityChanged: boolean = dto.visibility !== undefined && dto.visibility !== existing.visibility;
    const parentChanged: boolean = dto.parentId !== undefined && dto.parentId !== existing.parentId;
    if (visibilityChanged || audienceChanged || parentChanged) {
      await this.audit.record({
        organizationId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: visibilityChanged || parentChanged ? "kb.collection_visibility_changed" : "kb.collection_audience_changed",
        targetType: "kb_collection",
        targetId: id,
        summary: `Changed access to collection "${updated.name}"`,
        metadata: {
          visibility: { from: existing.visibility, to: updated.visibility },
          parentId: { from: existing.parentId, to: updated.parentId },
          ...(audienceChanged ? { audienceCompanyIds: { from: before, to: audience ?? [] } } : {}),
        },
        ...actor.context,
      });
    }
    return updated;
  }

  /**
   * Refuses to delete a collection that still holds articles or sub-collections:
   * they would lose the collection's visibility and could become visible to
   * more readers than intended.
   */
  async remove(organizationId: string, id: string, actor: KbActor): Promise<{ ok: true }> {
    const existing = await this.prisma.kbCollection.findFirst({
      where: { id, organizationId },
      include: { _count: { select: { articles: true, children: true } } },
    });
    if (!existing) throw new NotFoundException("Collection not found");
    if (existing._count.articles > 0 || existing._count.children > 0) {
      throw new ConflictException("Move or delete this collection's articles and sub-collections first");
    }
    await this.prisma.kbCollection.delete({ where: { id } });
    await this.audit.record({
      organizationId,
      actorId: actor.userId,
      actorEmail: actor.email,
      action: "kb.collection_deleted",
      targetType: "kb_collection",
      targetId: id,
      summary: `Deleted collection "${existing.name}"`,
      ...actor.context,
    });
    return { ok: true };
  }

  private async assertCollection(organizationId: string, id: string): Promise<void> {
    const found = await this.prisma.kbCollection.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!found) throw new BadRequestException("Parent collection not found");
  }

  private async assertNoCycle(organizationId: string, id: string, parentId: string): Promise<void> {
    if (parentId === id) throw new BadRequestException("A collection cannot be its own parent");
    const rows = await this.prisma.kbCollection.findMany({
      where: { organizationId },
      select: { id: true, parentId: true, visibility: true },
    });
    const byId = indexCollections(rows.map((r) => ({ ...r, audienceCompanyIds: [] })));
    if (collectionChain(parentId, byId).some((n) => n.id === id)) {
      throw new BadRequestException("A collection cannot be moved inside one of its own sub-collections");
    }
  }

  private async slugFor(organizationId: string, requested: string | undefined, name: string, excludeId?: string): Promise<string> {
    const taken = async (slug: string): Promise<boolean> =>
      !!(await this.prisma.kbCollection.findFirst({
        where: { organizationId, slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
        select: { id: true },
      }));
    if (requested) {
      if (await taken(requested)) throw new ConflictException("Another collection already uses this slug");
      return requested;
    }
    return availableSlug(slugify(name), taken);
  }
}
