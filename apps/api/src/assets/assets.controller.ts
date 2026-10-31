import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import type { Asset } from "@atrium/database";
import { AuthGuard, CurrentOrg, CurrentUser, Roles, RolesGuard, contentDisposition } from "../common";
import type { AuthenticatedRequest } from "../common/types/authenticated-request";
import { auditContext } from "../service-core";
import { AssetsService } from "./assets.service";
import type { AssetActor, AssetListItem } from "./assets.service";
import { AssetSyncService } from "./asset-sync.service";
import { parseAssetMapping } from "./asset-csv";
import {
  CreateAssetDto,
  ImportAssetsBodyDto,
  ListAssetsQueryDto,
  SyncAssetsDto,
  UpdateAssetDto,
} from "./assets.dto";

const MAX_CSV_BYTES = 2 * 1024 * 1024;

interface CsvUpload {
  originalname: string;
  buffer: Buffer;
}

function readCsv(file: CsvUpload | undefined): string {
  if (!file) throw new BadRequestException("No file provided");
  if (!file.originalname.toLowerCase().endsWith(".csv")) throw new BadRequestException("Only .csv files are supported");
  return file.buffer.toString("utf8");
}

export function actorOf(req: AuthenticatedRequest): AssetActor {
  return { id: req.user?.id ?? null, email: req.user?.email ?? null, ...auditContext(req) };
}

@Controller("assets")
@UseGuards(AuthGuard, RolesGuard)
export class AssetsController {
  constructor(
    private assets: AssetsService,
    private syncService: AssetSyncService,
  ) {}

  // Static routes must be declared before ":id".

  /** Portal: the client's company's client-visible assets. Read-only, any user of that company. */
  @Get("mine")
  mine(@CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string) {
    return this.assets.mine(userId, orgId);
  }

  @Get("export")
  @Roles("owner", "admin")
  async exportCsv(
    @CurrentOrg("id") orgId: string,
    @Query() query: ListAssetsQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.assets.exportCsv(orgId, query, actorOf(req));
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", contentDisposition("assets.csv"));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(csv);
  }

  @Post("import/preview")
  @Roles("owner", "admin")
  @HttpCode(200)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_CSV_BYTES } }))
  previewImport(@UploadedFile() file?: CsvUpload) {
    return this.assets.previewImport(readCsv(file));
  }

  @Post("import")
  @Roles("owner", "admin")
  @HttpCode(200)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_CSV_BYTES } }))
  importCsv(
    @UploadedFile() file: CsvUpload | undefined,
    @Body() body: ImportAssetsBodyDto,
    @CurrentOrg("id") orgId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const csv = readCsv(file);
    const mapping = parseAssetMapping(body.mapping);
    if (body.mapping !== undefined && !mapping) throw new BadRequestException("Invalid mapping");
    return this.assets.importCsv(orgId, csv, mapping, body.createCompanies === true, actorOf(req));
  }

  /**
   * Inventory feed for RMM/PSA connectors (cookie session or `atr_` API key).
   * Upserts on (workspace, source, externalId); `fullSync` retires the source's
   * assets missing from the batch.
   */
  @Put("sync/:source")
  @Roles("owner", "admin")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  sync(
    @Param("source") source: string,
    @Body() dto: SyncAssetsDto,
    @CurrentOrg("id") orgId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.syncService.sync(orgId, source, dto.assets, dto.fullSync === true, actorOf(req));
  }

  @Get("for-ticket/:ticketId")
  @Roles("owner", "admin")
  forTicket(@Param("ticketId") ticketId: string, @CurrentOrg("id") orgId: string): Promise<AssetListItem[]> {
    return this.assets.assetsForTicket(orgId, ticketId);
  }

  @Get()
  @Roles("owner", "admin")
  list(@CurrentOrg("id") orgId: string, @Query() query: ListAssetsQueryDto) {
    return this.assets.list(orgId, query);
  }

  @Post()
  @Roles("owner", "admin")
  create(@Body() dto: CreateAssetDto, @CurrentOrg("id") orgId: string, @Req() req: AuthenticatedRequest): Promise<Asset> {
    return this.assets.create(orgId, dto, actorOf(req));
  }

  @Get(":id")
  @Roles("owner", "admin")
  get(@Param("id") id: string, @CurrentOrg("id") orgId: string) {
    return this.assets.get(orgId, id);
  }

  @Put(":id")
  @Roles("owner", "admin")
  update(
    @Param("id") id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentOrg("id") orgId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<Asset> {
    return this.assets.update(orgId, id, dto, actorOf(req));
  }

  @Delete(":id")
  @Roles("owner", "admin")
  async remove(@Param("id") id: string, @CurrentOrg("id") orgId: string, @Req() req: AuthenticatedRequest) {
    await this.assets.remove(orgId, id, actorOf(req));
    return { deleted: true };
  }

  @Get(":id/tickets")
  @Roles("owner", "admin")
  tickets(@Param("id") id: string, @CurrentOrg("id") orgId: string) {
    return this.assets.ticketsFor(orgId, id);
  }

  @Post(":id/tickets/:ticketId")
  @Roles("owner", "admin")
  linkTicket(@Param("id") id: string, @Param("ticketId") ticketId: string, @CurrentOrg("id") orgId: string) {
    return this.assets.linkTicket(orgId, id, ticketId);
  }

  @Delete(":id/tickets/:ticketId")
  @Roles("owner", "admin")
  unlinkTicket(@Param("id") id: string, @Param("ticketId") ticketId: string, @CurrentOrg("id") orgId: string) {
    return this.assets.unlinkTicket(orgId, id, ticketId);
  }
}
