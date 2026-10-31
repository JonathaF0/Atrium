import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ClientScopeService } from "../service-core";
import { isPrivilegedRole } from "../common";
import { buildArticleFilter } from "./kb-visibility";
import type { KbArticleFilter, KbCollectionNode, KbReader } from "./kb-visibility";

export interface PublicKbOrg {
  id: string;
  name: string;
  slug: string;
}

/** Resolves who is reading and the visibility filter that applies to them. */
@Injectable()
export class KbAccessService {
  constructor(
    private prisma: PrismaService,
    private clientScope: ClientScopeService,
  ) {}

  async collectionNodes(organizationId: string): Promise<KbCollectionNode[]> {
    const rows = await this.prisma.kbCollection.findMany({
      where: { organizationId },
      select: { id: true, parentId: true, visibility: true, audiences: { select: { companyId: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      visibility: r.visibility,
      audienceCompanyIds: r.audiences.map((a) => a.companyId),
    }));
  }

  /**
   * Owners and admins read as staff. Anyone else (including an owner previewing
   * as a client, whose role the preview middleware has swapped) reads as a
   * client of their own contact's company.
   */
  async readerFor(userId: string, organizationId: string, role: string | undefined): Promise<KbReader> {
    if (isPrivilegedRole(role)) return { kind: "staff" };
    const scope = await this.clientScope.resolve(userId, organizationId);
    return { kind: "client", companyId: scope.companyId };
  }

  async filter(
    organizationId: string,
    reader: KbReader,
    opts: { publishedOnly?: boolean } = {},
  ): Promise<{ filter: KbArticleFilter; collections: KbCollectionNode[] }> {
    const collections: KbCollectionNode[] = reader.kind === "staff" ? [] : await this.collectionNodes(organizationId);
    return { filter: buildArticleFilter(organizationId, reader, collections, opts), collections };
  }

  /** The workspace behind a public help center URL; 404 unless it has turned the help center on. */
  async publicOrg(orgSlug: string): Promise<PublicKbOrg> {
    const org = await this.prisma.organization.findUnique({
      where: { slug: orgSlug },
      select: { id: true, name: true, slug: true },
    });
    if (!org) throw new NotFoundException("Help center not found");
    // Read-only lookup: an anonymous request must not create the settings row.
    const settings = await this.prisma.serviceSettings.findUnique({
      where: { organizationId: org.id },
      select: { kbPublicEnabled: true },
    });
    if (!settings?.kbPublicEnabled) throw new NotFoundException("Help center not found");
    return { id: org.id, name: org.name, slug: org.slug ?? orgSlug };
  }
}
