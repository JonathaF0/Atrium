import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@atrium/database";
import type { Asset } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, ClientScopeService } from "../service-core";
import { paginatedResponse, paginationArgs } from "../common";
import type { Paginated } from "../common";
import { parseCsv } from "../contacts/contacts-csv";
import { metadataError, parseDateInput } from "./asset-fields";
import type { AssetMetadata } from "./asset-fields";
import {
  MAX_ASSET_IMPORT_ROWS,
  assetsToCsv,
  planAssetImport,
  suggestMapping,
} from "./asset-csv";
import type { AssetImportMapping } from "./asset-csv";
import type { CreateAssetDto, ListAssetsQueryDto, UpdateAssetDto } from "./assets.dto";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_MAX_ROWS = 20_000;

/** Who did it, for the audit log. */
export interface AssetActor {
  id: string | null;
  email?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** What a portal client sees of an asset: no notes, metadata or sync identifiers. */
const PORTAL_SELECT = {
  id: true,
  type: true,
  name: true,
  vendor: true,
  model: true,
  serialNumber: true,
  assignedTo: true,
  status: true,
  seats: true,
  purchaseDate: true,
  warrantyEndsAt: true,
  renewsAt: true,
} satisfies Prisma.AssetSelect;

const TICKET_SELECT = {
  id: true,
  number: true,
  subject: true,
  status: true,
  priority: true,
  companyId: true,
  updatedAt: true,
} satisfies Prisma.TicketSelect;

export type AssetListItem = Asset & { company: { id: string; name: string }; _count: { tickets: number } };

export interface AssetImportResult {
  created: number;
  updated: number;
  skipped: Array<{ row: number; reason: string }>;
  companiesCreated: number;
}

/** null clears a Json column; undefined leaves it alone. */
export function jsonValue(value: AssetMetadata | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function dateValue(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const d = parseDateInput(value);
  if (!d) throw new BadRequestException("Dates must be YYYY-MM-DD or ISO 8601");
  return d;
}

function trimmed(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const t = value.trim();
  return t ? t : null;
}

export function assetListWhere(orgId: string, query: ListAssetsQueryDto, now: Date): Prisma.AssetWhereInput {
  const and: Prisma.AssetWhereInput[] = [{ organizationId: orgId }];
  if (query.companyId) and.push({ companyId: query.companyId });
  if (query.type) and.push({ type: query.type });
  if (query.status) and.push({ status: query.status });
  if (query.expiringWithinDays !== undefined) {
    const range = { gte: new Date(now.getTime() - DAY_MS), lte: new Date(now.getTime() + query.expiringWithinDays * DAY_MS) };
    and.push({ status: { not: "retired" } });
    and.push({ OR: [{ warrantyEndsAt: range }, { renewsAt: range }] });
  }
  const q = query.q?.trim();
  if (q) {
    const contains = { contains: q, mode: "insensitive" as const };
    and.push({
      OR: [
        { name: contains },
        { serialNumber: contains },
        { vendor: contains },
        { model: contains },
        { assignedTo: contains },
        { externalId: contains },
      ],
    });
  }
  return { AND: and };
}

@Injectable()
export class AssetsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private clientScope: ClientScopeService,
  ) {}

  async list(orgId: string, query: ListAssetsQueryDto, now: Date = new Date()): Promise<Paginated<AssetListItem>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = assetListWhere(orgId, query, now);
    const [data, total] = await Promise.all([
      this.prisma.asset.findMany({
        where,
        include: { company: { select: { id: true, name: true } }, _count: { select: { tickets: true } } },
        orderBy: [{ company: { name: "asc" } }, { name: "asc" }, { id: "asc" }],
        ...paginationArgs(page, limit),
      }),
      this.prisma.asset.count({ where }),
    ]);
    return paginatedResponse(data, total, page, limit);
  }

  async get(orgId: string, id: string): Promise<AssetListItem> {
    const asset = await this.prisma.asset.findFirst({
      where: { id, organizationId: orgId },
      include: { company: { select: { id: true, name: true } }, _count: { select: { tickets: true } } },
    });
    if (!asset) throw new NotFoundException("Asset not found");
    return asset;
  }

  async create(orgId: string, dto: CreateAssetDto, actor: AssetActor): Promise<Asset> {
    await this.assertCompany(orgId, dto.companyId);
    this.assertMetadata(dto.metadata);
    const asset = await this.prisma.asset.create({
      data: {
        organizationId: orgId,
        companyId: dto.companyId,
        type: dto.type,
        name: dto.name.trim(),
        ...this.fieldData(dto),
        status: dto.status ?? "active",
      },
    });
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "asset.created",
      targetType: "asset",
      targetId: asset.id,
      summary: `Created asset ${asset.name}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return asset;
  }

  async update(orgId: string, id: string, dto: UpdateAssetDto, actor: AssetActor): Promise<Asset> {
    const current = await this.get(orgId, id);
    if (dto.companyId && dto.companyId !== current.companyId) await this.assertCompany(orgId, dto.companyId);
    this.assertMetadata(dto.metadata);
    const fields = this.fieldData(dto);
    const datesChanged =
      (fields.warrantyEndsAt !== undefined && fields.warrantyEndsAt?.getTime() !== current.warrantyEndsAt?.getTime()) ||
      (fields.renewsAt !== undefined && fields.renewsAt?.getTime() !== current.renewsAt?.getTime());
    const asset = await this.prisma.asset.update({
      where: { id },
      data: {
        companyId: dto.companyId,
        type: dto.type,
        name: dto.name?.trim(),
        ...fields,
        status: dto.status,
        // A new date starts a new renewal cycle.
        ...(datesChanged ? { renewalNotifiedAt: null } : {}),
      },
    });
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "asset.updated",
      targetType: "asset",
      targetId: id,
      summary: `Updated asset ${asset.name}`,
      metadata: { fields: Object.keys(dto) },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return asset;
  }

  async remove(orgId: string, id: string, actor: AssetActor): Promise<void> {
    const asset = await this.get(orgId, id);
    await this.prisma.asset.delete({ where: { id } });
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "asset.deleted",
      targetType: "asset",
      targetId: id,
      summary: `Deleted asset ${asset.name}`,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  async exportCsv(orgId: string, query: ListAssetsQueryDto, actor: AssetActor): Promise<string> {
    const where = assetListWhere(orgId, query, new Date());
    const assets = await this.prisma.asset.findMany({
      where,
      include: { company: { select: { name: true } } },
      orderBy: [{ company: { name: "asc" } }, { name: "asc" }, { id: "asc" }],
      take: EXPORT_MAX_ROWS,
    });
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "asset.exported",
      targetType: "asset",
      summary: `Exported ${assets.length} asset(s) to CSV`,
      metadata: {
        count: assets.length,
        filters: {
          companyId: query.companyId ?? null,
          type: query.type ?? null,
          status: query.status ?? null,
          expiringWithinDays: query.expiringWithinDays ?? null,
          q: query.q ?? null,
        },
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return assetsToCsv(assets);
  }

  previewImport(csv: string): { headers: string[]; rows: string[][]; total: number; mapping: AssetImportMapping } {
    const [headers = [], ...data] = parseCsv(csv);
    if (data.length > MAX_ASSET_IMPORT_ROWS) {
      throw new BadRequestException(`A file may have at most ${MAX_ASSET_IMPORT_ROWS} rows`);
    }
    return { headers, rows: data.slice(0, 5), total: data.length, mapping: suggestMapping(headers) };
  }

  /**
   * Creates or updates assets from a CSV. A row updates an existing asset when its
   * external ID or, failing that, its serial number matches one in the workspace.
   */
  async importCsv(
    orgId: string,
    csv: string,
    mapping: AssetImportMapping | null,
    createCompanies: boolean,
    actor: AssetActor,
  ): Promise<AssetImportResult> {
    const [headers = [], ...data] = parseCsv(csv);
    if (data.length > MAX_ASSET_IMPORT_ROWS) {
      throw new BadRequestException(`A file may have at most ${MAX_ASSET_IMPORT_ROWS} rows`);
    }
    const planned = planAssetImport(headers, data, mapping ?? suggestMapping(headers));
    const result: AssetImportResult = { created: 0, updated: 0, skipped: [], companiesCreated: 0 };

    const companies = await this.prisma.company.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } });
    const companyByName = new Map(companies.map((c) => [c.name.trim().toLowerCase(), c.id]));

    const drafts = planned.flatMap((p) => ("draft" in p ? [p] : []));
    const externalIds = [...new Set(drafts.map((p) => p.draft.externalId).filter((v): v is string => !!v))];
    const serials = [...new Set(drafts.map((p) => p.draft.serialNumber).filter((v): v is string => !!v))];
    const existing = await this.prisma.asset.findMany({
      where: {
        organizationId: orgId,
        OR: [
          ...(externalIds.length ? [{ externalId: { in: externalIds } }] : []),
          ...(serials.length ? [{ serialNumber: { in: serials, mode: "insensitive" as const } }] : []),
        ],
      },
      select: { id: true, externalId: true, serialNumber: true },
      orderBy: { createdAt: "asc" },
    });
    const byExternal = new Map<string, string>();
    const bySerial = new Map<string, string>();
    for (const a of existing) {
      if (a.externalId && !byExternal.has(a.externalId)) byExternal.set(a.externalId, a.id);
      if (a.serialNumber && !bySerial.has(a.serialNumber.toLowerCase())) bySerial.set(a.serialNumber.toLowerCase(), a.id);
    }

    for (const p of planned) {
      if ("skip" in p) {
        result.skipped.push({ row: p.row, reason: p.skip });
        continue;
      }
      const d = p.draft;
      let companyId = companyByName.get(d.company.toLowerCase());
      if (!companyId) {
        if (!createCompanies) {
          result.skipped.push({ row: p.row, reason: `Unknown company "${d.company.slice(0, 100)}"` });
          continue;
        }
        const created = await this.prisma.company.upsert({
          where: { organizationId_name: { organizationId: orgId, name: d.company } },
          create: { organizationId: orgId, name: d.company },
          update: {},
          select: { id: true },
        });
        companyId = created.id;
        companyByName.set(d.company.toLowerCase(), companyId);
        result.companiesCreated++;
      }
      const fields = {
        companyId,
        type: d.type,
        name: d.name,
        vendor: d.vendor,
        model: d.model,
        serialNumber: d.serialNumber,
        assignedTo: d.assignedTo,
        seats: d.seats,
        purchaseDate: d.purchaseDate,
        warrantyEndsAt: d.warrantyEndsAt,
        renewsAt: d.renewsAt,
        notes: d.notes,
        ...(d.status ? { status: d.status } : {}),
        ...(d.clientVisible !== null ? { clientVisible: d.clientVisible } : {}),
      };
      const matchId =
        (d.externalId ? byExternal.get(d.externalId) : undefined) ??
        (d.serialNumber ? bySerial.get(d.serialNumber.toLowerCase()) : undefined);
      try {
        if (matchId) {
          await this.prisma.asset.update({ where: { id: matchId }, data: fields });
          result.updated++;
        } else {
          const created = await this.prisma.asset.create({
            data: {
              organizationId: orgId,
              ...fields,
              // Imported external IDs belong to the "csv" source so they never collide with a connector's.
              ...(d.externalId ? { externalSource: "csv", externalId: d.externalId } : {}),
            },
            select: { id: true },
          });
          if (d.externalId) byExternal.set(d.externalId, created.id);
          if (d.serialNumber) bySerial.set(d.serialNumber.toLowerCase(), created.id);
          result.created++;
        }
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          result.skipped.push({ row: p.row, reason: "Duplicate external ID" });
          continue;
        }
        throw err;
      }
    }

    await this.audit.record({
      organizationId: orgId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "asset.imported",
      targetType: "asset",
      summary: `Imported assets from CSV: ${result.created} created, ${result.updated} updated, ${result.skipped.length} skipped`,
      metadata: { created: result.created, updated: result.updated, skipped: result.skipped.length },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return result;
  }

  /** The portal user's company's client-visible assets; empty for users without a company. */
  async mine(userId: string, orgId: string) {
    const scope = await this.clientScope.resolve(userId, orgId);
    if (!scope.companyId) return [];
    return this.prisma.asset.findMany({
      where: { organizationId: orgId, companyId: scope.companyId, clientVisible: true, status: { not: "retired" } },
      select: PORTAL_SELECT,
      orderBy: [{ type: "asc" }, { name: "asc" }, { id: "asc" }],
      take: 1000,
    });
  }

  // ── Ticket links ──

  async ticketsFor(orgId: string, assetId: string) {
    await this.get(orgId, assetId);
    return this.prisma.ticket.findMany({
      where: { organizationId: orgId, OR: [{ assets: { some: { assetId } } }, { assetId }] },
      select: TICKET_SELECT,
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
  }

  async assetsForTicket(orgId: string, ticketId: string): Promise<AssetListItem[]> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, organizationId: orgId },
      select: { id: true, assetId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return this.prisma.asset.findMany({
      where: {
        organizationId: orgId,
        OR: [{ tickets: { some: { ticketId } } }, ...(ticket.assetId ? [{ id: ticket.assetId }] : [])],
      },
      include: { company: { select: { id: true, name: true } }, _count: { select: { tickets: true } } },
      orderBy: { name: "asc" },
    });
  }

  async linkTicket(orgId: string, assetId: string, ticketId: string): Promise<{ linked: true }> {
    const [asset, ticket] = await Promise.all([
      this.prisma.asset.findFirst({ where: { id: assetId, organizationId: orgId }, select: { companyId: true } }),
      this.prisma.ticket.findFirst({ where: { id: ticketId, organizationId: orgId }, select: { companyId: true } }),
    ]);
    if (!asset) throw new NotFoundException("Asset not found");
    if (!ticket) throw new NotFoundException("Ticket not found");
    if (ticket.companyId && ticket.companyId !== asset.companyId) {
      throw new BadRequestException("The asset belongs to a different company than the ticket");
    }
    await this.prisma.ticketAsset.createMany({ data: [{ ticketId, assetId }], skipDuplicates: true });
    return { linked: true };
  }

  async unlinkTicket(orgId: string, assetId: string, ticketId: string): Promise<{ linked: false }> {
    await this.get(orgId, assetId);
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, organizationId: orgId }, select: { id: true } });
    if (!ticket) throw new NotFoundException("Ticket not found");
    await this.prisma.ticketAsset.deleteMany({ where: { ticketId, assetId } });
    return { linked: false };
  }

  // ── helpers ──

  private async assertCompany(orgId: string, companyId: string): Promise<void> {
    const company = await this.prisma.company.findFirst({ where: { id: companyId, organizationId: orgId }, select: { id: true } });
    if (!company) throw new BadRequestException("Company not found");
  }

  private assertMetadata(value: unknown): void {
    const err = metadataError(value);
    if (err) throw new BadRequestException(err);
  }

  private fieldData(dto: UpdateAssetDto) {
    return {
      vendor: trimmed(dto.vendor),
      model: trimmed(dto.model),
      serialNumber: trimmed(dto.serialNumber),
      assignedTo: trimmed(dto.assignedTo),
      seats: dto.seats,
      purchaseDate: dateValue(dto.purchaseDate),
      warrantyEndsAt: dateValue(dto.warrantyEndsAt),
      renewsAt: dateValue(dto.renewsAt),
      notes: dto.notes === undefined ? undefined : dto.notes?.trim() || null,
      clientVisible: dto.clientVisible,
      metadata: jsonValue(dto.metadata),
    };
  }
}
