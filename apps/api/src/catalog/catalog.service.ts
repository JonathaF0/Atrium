import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { CatalogItem, Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { paginatedResponse, paginationArgs } from "../common";
import {
  BundleItemDto,
  CatalogBundleDto,
  CatalogItemDto,
  CatalogListQueryDto,
  UpdateCatalogBundleDto,
  UpdateCatalogItemDto,
} from "./catalog.dto";

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: string }).code === "P2002";
}

function blankToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v?.trim();
  return t ? t : null;
}

const bundleInclude = {
  items: { orderBy: { order: "asc" }, include: { catalogItem: true } },
} satisfies Prisma.CatalogBundleInclude;

type BundleWithItems = Prisma.CatalogBundleGetPayload<{ include: typeof bundleInclude }>;

export function serializeBundle(b: BundleWithItems) {
  return {
    ...b,
    items: b.items.map((i) => ({ ...i, quantity: Number(i.quantity) })),
  };
}

@Injectable()
export class CatalogService {
  constructor(private prisma: PrismaService) {}

  // ─── Items ───

  async listItems(orgId: string, q: CatalogListQueryDto) {
    const { page = 1, limit = 50 } = q;
    const where: Prisma.CatalogItemWhereInput = {
      organizationId: orgId,
      archivedAt: q.archived === "true" ? { not: null } : null,
    };
    if (q.category) where.category = q.category;
    const search = q.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { category: { contains: search, mode: "insensitive" } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.catalogItem.findMany({
        where,
        orderBy: [{ category: "asc" }, { name: "asc" }],
        ...paginationArgs(page, limit),
      }),
      this.prisma.catalogItem.count({ where }),
    ]);
    return paginatedResponse(data, total, page, limit);
  }

  async categories(orgId: string): Promise<string[]> {
    const rows = await this.prisma.catalogItem.findMany({
      where: { organizationId: orgId, archivedAt: null, category: { not: null } },
      distinct: ["category"],
      select: { category: true },
      orderBy: { category: "asc" },
    });
    return rows.map((r) => r.category!).filter(Boolean);
  }

  async getItem(orgId: string, id: string): Promise<CatalogItem> {
    const item = await this.prisma.catalogItem.findFirst({ where: { id, organizationId: orgId } });
    if (!item) throw new NotFoundException("Catalog item not found");
    return item;
  }

  createItem(orgId: string, dto: CatalogItemDto): Promise<CatalogItem> {
    return this.prisma.catalogItem.create({
      data: {
        organizationId: orgId,
        name: dto.name.trim(),
        description: blankToNull(dto.description) ?? null,
        category: blankToNull(dto.category) ?? null,
        unit: dto.unit?.trim() || (dto.billingType === "hourly" ? "hour" : "each"),
        billingType: dto.billingType,
        recurringInterval: dto.billingType === "recurring" ? (dto.recurringInterval ?? "monthly") : null,
        rateCents: dto.rateCents,
        costCents: dto.costCents ?? null,
        taxable: dto.taxable ?? true,
      },
    });
  }

  async updateItem(orgId: string, id: string, dto: UpdateCatalogItemDto): Promise<CatalogItem> {
    const existing = await this.getItem(orgId, id);
    const billingType = dto.billingType ?? existing.billingType;
    let recurringInterval: string | null | undefined = dto.recurringInterval;
    if (billingType !== "recurring") recurringInterval = null;
    else if (!recurringInterval && !existing.recurringInterval) recurringInterval = "monthly";
    return this.prisma.catalogItem.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        description: blankToNull(dto.description),
        category: blankToNull(dto.category),
        unit: dto.unit?.trim() || undefined,
        billingType: dto.billingType,
        recurringInterval,
        rateCents: dto.rateCents,
        costCents: dto.costCents,
        taxable: dto.taxable,
        archivedAt: dto.archived === undefined ? undefined : dto.archived ? (existing.archivedAt ?? new Date()) : null,
      },
    });
  }

  async removeItem(orgId: string, id: string): Promise<void> {
    await this.getItem(orgId, id);
    const inBundles = await this.prisma.catalogBundleItem.count({ where: { catalogItemId: id } });
    if (inBundles > 0) {
      throw new ConflictException("This item is used in a bundle. Archive it instead, or remove it from the bundle first.");
    }
    await this.prisma.catalogItem.delete({ where: { id } });
  }

  // ─── Bundles ───

  async listBundles(orgId: string, q: CatalogListQueryDto) {
    const where: Prisma.CatalogBundleWhereInput = {
      organizationId: orgId,
      archivedAt: q.archived === "true" ? { not: null } : null,
    };
    const search = q.search?.trim();
    if (search) where.name = { contains: search, mode: "insensitive" };
    const bundles = await this.prisma.catalogBundle.findMany({
      where,
      include: bundleInclude,
      orderBy: { name: "asc" },
      take: 200,
    });
    return bundles.map(serializeBundle);
  }

  async getBundle(orgId: string, id: string) {
    const bundle = await this.prisma.catalogBundle.findFirst({
      where: { id, organizationId: orgId },
      include: bundleInclude,
    });
    if (!bundle) throw new NotFoundException("Bundle not found");
    return serializeBundle(bundle);
  }

  /** Every referenced item must belong to this workspace. */
  private async assertItems(orgId: string, items: BundleItemDto[]): Promise<void> {
    const ids = [...new Set(items.map((i) => i.catalogItemId))];
    if (ids.length === 0) return;
    const found = await this.prisma.catalogItem.count({ where: { id: { in: ids }, organizationId: orgId } });
    if (found !== ids.length) throw new BadRequestException("Unknown catalog item in bundle");
  }

  async createBundle(orgId: string, dto: CatalogBundleDto) {
    await this.assertItems(orgId, dto.items);
    try {
      const bundle = await this.prisma.catalogBundle.create({
        data: {
          organizationId: orgId,
          name: dto.name.trim(),
          description: blankToNull(dto.description) ?? null,
          items: {
            create: dto.items.map((i, order) => ({
              catalogItemId: i.catalogItemId,
              quantity: i.quantity,
              optional: !!i.optional,
              order,
            })),
          },
        },
        include: bundleInclude,
      });
      return serializeBundle(bundle);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A bundle with this name already exists");
      throw err;
    }
  }

  async updateBundle(orgId: string, id: string, dto: UpdateCatalogBundleDto) {
    const existing = await this.getBundle(orgId, id);
    if (dto.items) await this.assertItems(orgId, dto.items);
    try {
      const bundle = await this.prisma.$transaction(async (tx) => {
        if (dto.items) {
          await tx.catalogBundleItem.deleteMany({ where: { bundleId: id } });
          await tx.catalogBundleItem.createMany({
            data: dto.items.map((i, order) => ({
              bundleId: id,
              catalogItemId: i.catalogItemId,
              quantity: i.quantity,
              optional: !!i.optional,
              order,
            })),
          });
        }
        return tx.catalogBundle.update({
          where: { id },
          data: {
            name: dto.name?.trim(),
            description: blankToNull(dto.description),
            archivedAt:
              dto.archived === undefined ? undefined : dto.archived ? (existing.archivedAt ?? new Date()) : null,
          },
          include: bundleInclude,
        });
      });
      return serializeBundle(bundle);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A bundle with this name already exists");
      throw err;
    }
  }

  async removeBundle(orgId: string, id: string): Promise<void> {
    const { count } = await this.prisma.catalogBundle.deleteMany({ where: { id, organizationId: orgId } });
    if (count === 0) throw new NotFoundException("Bundle not found");
  }
}
