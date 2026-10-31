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
import { AuthGuard, CurrentOrg, CurrentUser, Roles, RolesGuard } from "../common";
import type { AuthUser } from "../common";
import { MAX_UPLOAD_BYTES, type TempUploadedFile } from "../files/files.service";
import { TempFileInterceptor } from "../files/temp-file.interceptor";
import { AttachmentStorageService, auditContext } from "../service-core";
import { sendKbAttachment } from "../kb/kb-attachment-response";
import { ClientDocsService } from "./client-docs.service";
import type { ClientDocActor } from "./client-docs.service";
import { CreateClientDocDto, ListClientDocsQueryDto, UpdateClientDocDto } from "./client-docs.dto";

function actorOf(user: AuthUser, req: Request): ClientDocActor {
  return { userId: user.id, email: user.email, context: auditContext(req) };
}

@Controller("client-docs")
@UseGuards(AuthGuard, RolesGuard)
export class ClientDocsController {
  constructor(
    private docs: ClientDocsService,
    private storage: AttachmentStorageService,
  ) {}

  // Portal routes first, so "mine" never reaches the ":id" handlers.

  @Get("mine")
  listMine(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string) {
    return this.docs.listMine(orgId, userId);
  }

  @Get("mine/attachments/:attachmentId")
  async mineAttachment(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Param("attachmentId") attachmentId: string,
    @Res() res: Response,
  ): Promise<void> {
    await sendKbAttachment(res, await this.docs.mineAttachment(orgId, userId, attachmentId), this.storage);
  }

  // Staff routes.

  @Get()
  @Roles("owner", "admin")
  list(@CurrentOrg("id") orgId: string, @Query() query: ListClientDocsQueryDto) {
    return this.docs.list(orgId, query.companyId);
  }

  @Post()
  @Roles("owner", "admin")
  create(@CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: CreateClientDocDto, @Req() req: Request) {
    return this.docs.create(orgId, dto, actorOf(user, req));
  }

  @Get("attachments/:attachmentId")
  @Roles("owner", "admin")
  async attachment(
    @CurrentOrg("id") orgId: string,
    @Param("attachmentId") attachmentId: string,
    @Res() res: Response,
  ): Promise<void> {
    await sendKbAttachment(res, await this.docs.staffAttachment(orgId, attachmentId), this.storage);
  }

  @Get(":id")
  @Roles("owner", "admin")
  get(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    return this.docs.get(orgId, id);
  }

  @Patch(":id")
  @Roles("owner", "admin")
  update(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() dto: UpdateClientDocDto,
    @Req() req: Request,
  ) {
    return this.docs.update(orgId, id, dto, actorOf(user, req));
  }

  @Delete(":id")
  @Roles("owner", "admin")
  remove(@CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: Request) {
    return this.docs.remove(orgId, id, actorOf(user, req));
  }

  @Post(":id/attachments")
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
    return this.docs.addAttachment(orgId, id, file, actorOf(user, req));
  }

  @Delete(":id/attachments/:attachmentId")
  @Roles("owner", "admin")
  removeAttachment(
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
    @Req() req: Request,
  ) {
    return this.docs.removeAttachment(orgId, id, attachmentId, actorOf(user, req));
  }
}
