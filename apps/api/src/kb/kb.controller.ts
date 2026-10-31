import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthGuard, CurrentMember, CurrentOrg, CurrentUser, Roles, RolesGuard } from "../common";
import type { AuthUser } from "../common";
import { MAX_UPLOAD_BYTES, type TempUploadedFile } from "../files/files.service";
import { TempFileInterceptor } from "../files/temp-file.interceptor";
import { AttachmentStorageService, AuditService, ServiceSettingsService, auditContext } from "../service-core";
import {
  CreateKbArticleDto,
  CreateKbCollectionDto,
  KbRestoreRevisionDto,
  KbSettingsDto,
  ListKbArticlesQueryDto,
  UpdateKbArticleDto,
  UpdateKbCollectionDto,
} from "./kb.dto";
import { KbArticlesService } from "./kb-articles.service";
import { KbCollectionsService } from "./kb-collections.service";
import { KbAccessService } from "./kb-access.service";
import { KbReaderService } from "./kb-reader.service";
import { sendKbAttachment } from "./kb-attachment-response";
import type { KbActor } from "./kb-helpers";
import type { KbWorkflowAction } from "./kb-workflow";

function actorOf(user: AuthUser, req: Request): KbActor {
  return { userId: user.id, email: user.email, context: auditContext(req) };
}

/** Staff authoring. Reader routes live in KbPortalController (/kb/mine) and KbPublicController. */
@Controller("kb")
@UseGuards(AuthGuard, RolesGuard)
export class KbController {
  constructor(
    private articles: KbArticlesService,
    private collections: KbCollectionsService,
    private reader: KbReaderService,
    private access: KbAccessService,
    private settings: ServiceSettingsService,
    private audit: AuditService,
    private storage: AttachmentStorageService,
  ) {}

  @Get("settings")
  @Roles("owner", "admin")
  async getSettings(@CurrentOrg("id") orgId: string, @CurrentOrg("slug") orgSlug: string | null) {
    const s = await this.settings.get(orgId);
    return { kbPublicEnabled: s.kbPublicEnabled, kbReviewDays: s.kbReviewDays, orgSlug };
  }

  @Patch("settings")
  @Roles("owner", "admin")
  async updateSettings(
    @CurrentOrg("id") orgId: string,
    @CurrentOrg("slug") orgSlug: string | null,
    @CurrentUser() user: AuthUser,
    @Body() dto: KbSettingsDto,
    @Req() req: Request,
  ) {
    const before = await this.settings.get(orgId);
    const s = await this.settings.update(orgId, dto);
    if (dto.kbPublicEnabled !== undefined && dto.kbPublicEnabled !== before.kbPublicEnabled) {
      await this.audit.record({
        organizationId: orgId,
        actorId: user.id,
        actorEmail: user.email,
        action: dto.kbPublicEnabled ? "kb.public_enabled" : "kb.public_disabled",
        targetType: "service_settings",
        targetId: s.id,
        summary: dto.kbPublicEnabled ? "Turned on the public help center" : "Turned off the public help center",
        ...auditContext(req),
      });
    }
    return { kbPublicEnabled: s.kbPublicEnabled, kbReviewDays: s.kbReviewDays, orgSlug };
  }

  @Get("staff")
  @Roles("owner", "admin")
  staff(@CurrentOrg("id") orgId: string) {
    return this.articles.staff(orgId);
  }

  @Get("stats")
  @Roles("owner", "admin")
  stats(@CurrentOrg("id") orgId: string) {
    return this.articles.stats(orgId);
  }

  // ─── Collections ───

  @Get("collections")
  @Roles("owner", "admin")
  listCollections(@CurrentOrg("id") orgId: string) {
    return this.collections.list(orgId);
  }

  @Post("collections")
  @Roles("owner", "admin")
  createCollection(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateKbCollectionDto,
    @Req() req: Request,
  ) {
    return this.collections.create(orgId, dto, actorOf(user, req));
  }

  @Patch("collections/:id")
  @Roles("owner", "admin")
  updateCollection(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() dto: UpdateKbCollectionDto,
    @Req() req: Request,
  ) {
    return this.collections.update(orgId, id, dto, actorOf(user, req));
  }

  @Delete("collections/:id")
  @Roles("owner", "admin")
  removeCollection(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    return this.collections.remove(orgId, id, actorOf(user, req));
  }

  // ─── Articles ───

  @Get("articles")
  @Roles("owner", "admin")
  listArticles(@CurrentOrg("id") orgId: string, @Query() query: ListKbArticlesQueryDto) {
    return this.articles.list(orgId, query);
  }

  /** Full-text search across every article, drafts included (staff only). */
  @Get("search")
  @Roles("owner", "admin")
  search(@CurrentOrg("id") orgId: string, @Query("q") q: string = "") {
    return this.reader.search(orgId, { kind: "staff" }, String(q).slice(0, 200), { limit: 20, publishedOnly: false });
  }

  @Post("articles")
  @Roles("owner", "admin")
  createArticle(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateKbArticleDto,
    @Req() req: Request,
  ) {
    return this.articles.create(orgId, dto, actorOf(user, req));
  }

  @Post("articles/from-ticket/:ticketId")
  @Roles("owner", "admin")
  fromTicket(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Param("ticketId") ticketId: string,
    @Req() req: Request,
  ) {
    return this.articles.fromTicket(orgId, ticketId, actorOf(user, req));
  }

  @Get("articles/:id")
  @Roles("owner", "admin")
  getArticle(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    return this.articles.get(orgId, id);
  }

  @Patch("articles/:id")
  @Roles("owner", "admin")
  updateArticle(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() dto: UpdateKbArticleDto,
    @Req() req: Request,
  ) {
    return this.articles.update(orgId, id, dto, actorOf(user, req));
  }

  @Delete("articles/:id")
  @Roles("owner", "admin")
  removeArticle(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    return this.articles.remove(orgId, id, actorOf(user, req));
  }

  @Post("articles/:id/submit")
  @Roles("owner", "admin")
  submit(@CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.transition(orgId, user, id, "submit", req);
  }

  @Post("articles/:id/publish")
  @Roles("owner", "admin")
  publish(@CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.transition(orgId, user, id, "publish", req);
  }

  @Post("articles/:id/unpublish")
  @Roles("owner", "admin")
  unpublish(@CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.transition(orgId, user, id, "unpublish", req);
  }

  @Post("articles/:id/archive")
  @Roles("owner", "admin")
  archive(@CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.transition(orgId, user, id, "archive", req);
  }

  private transition(orgId: string, user: AuthUser, id: string, action: KbWorkflowAction, req: Request) {
    return this.articles.transition(orgId, id, action, actorOf(user, req));
  }

  @Get("articles/:id/revisions")
  @Roles("owner", "admin")
  revisions(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    return this.articles.revisions(orgId, id);
  }

  @Post("articles/:id/revisions/:revisionId/restore")
  @Roles("owner", "admin")
  restore(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("revisionId") revisionId: string,
    @Body() dto: KbRestoreRevisionDto,
    @Req() req: Request,
  ) {
    return this.articles.restore(orgId, id, revisionId, actorOf(user, req), dto.note);
  }

  @Post("articles/:id/attachments")
  @Roles("owner", "admin")
  @UseInterceptors(TempFileInterceptor("file", MAX_UPLOAD_BYTES))
  upload(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @UploadedFile() file: TempUploadedFile,
    @Req() req: Request,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    return this.articles.addAttachment(orgId, id, file, actorOf(user, req));
  }

  @Delete("articles/:id/attachments/:attachmentId")
  @Roles("owner", "admin")
  removeAttachment(
    @CurrentOrg("id") orgId: string,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
  ) {
    return this.articles.removeAttachment(orgId, id, attachmentId);
  }

  /** Any signed-in member; the reader's visibility rules decide. */
  @Get("attachments/:id")
  async attachment(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @CurrentMember("role") role: string,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    const reader = await this.access.readerFor(userId, orgId, role);
    await sendKbAttachment(res, await this.reader.attachment(orgId, reader, id), this.storage);
  }
}
