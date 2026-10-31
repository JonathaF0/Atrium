import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { AuthGuard, CurrentMember, CurrentOrg, CurrentUser } from "../common";
import { MAX_UPLOAD_BYTES, type TempUploadedFile } from "../files/files.service";
import { TempFileInterceptor } from "../files/temp-file.interceptor";
import { TicketsService } from "./tickets.service";
import { HelpdeskSettingsService } from "./helpdesk-settings.service";
import { CreatePortalTicketDto, CsatDto, PortalTicketQueryDto, ReplyDto } from "./helpdesk.dto";
import { sendAttachment } from "./attachment-response";

const WRITE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * Portal ("mine") ticket routes. No @Roles: access is scoped in the service to
 * the client's own tickets, plus their company's when they are a company admin.
 * Registered before the staff controller so `/tickets/mine` never matches `/tickets/:id`.
 */
@Controller("tickets/mine")
@UseGuards(AuthGuard)
export class TicketsPortalController {
  constructor(
    private tickets: TicketsService,
    private settings: HelpdeskSettingsService,
  ) {}

  @Get()
  list(@CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string, @Query() query: PortalTicketQueryDto) {
    return this.tickets.listForClient(userId, orgId, query);
  }

  @Get("categories")
  categories(@CurrentOrg("id") orgId: string) {
    return this.settings.portalCategories(orgId);
  }

  @Post()
  @Throttle(WRITE_THROTTLE)
  create(
    @CurrentUser("id") userId: string,
    @CurrentMember("role") role: string,
    @CurrentOrg("id") orgId: string,
    @Body() dto: CreatePortalTicketDto,
  ) {
    return this.tickets.createForClient(userId, role, orgId, dto);
  }

  @Get("attachments/:attachmentId")
  async download(
    @Param("attachmentId") attachmentId: string,
    @CurrentUser("id") userId: string,
    @CurrentOrg("id") orgId: string,
    @Res() res: Response,
  ) {
    sendAttachment(res, await this.tickets.downloadForClient(attachmentId, userId, orgId));
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string) {
    return this.tickets.findOneForClient(id, userId, orgId);
  }

  @Post(":id/reply")
  @Throttle(WRITE_THROTTLE)
  reply(@Param("id") id: string, @CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string, @Body() dto: ReplyDto) {
    return this.tickets.replyAsClient(id, userId, orgId, dto.body);
  }

  @Post(":id/attachments")
  @Throttle(WRITE_THROTTLE)
  @UseInterceptors(TempFileInterceptor("file", MAX_UPLOAD_BYTES))
  upload(
    @Param("id") id: string,
    @Query("messageId") messageId: string,
    @UploadedFile() file: TempUploadedFile,
    @CurrentUser("id") userId: string,
    @CurrentOrg("id") orgId: string,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    if (!messageId) throw new BadRequestException("messageId is required");
    return this.tickets.addClientAttachment(id, userId, orgId, messageId, file);
  }

  @Post(":id/reopen")
  @Throttle(WRITE_THROTTLE)
  reopen(@Param("id") id: string, @CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string) {
    return this.tickets.reopenAsClient(id, userId, orgId);
  }

  @Post(":id/close")
  @Throttle(WRITE_THROTTLE)
  close(@Param("id") id: string, @CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string) {
    return this.tickets.closeAsClient(id, userId, orgId);
  }

  @Post(":id/csat")
  @Throttle(WRITE_THROTTLE)
  rate(@Param("id") id: string, @CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string, @Body() dto: CsatDto) {
    return this.tickets.rateAsClient(id, userId, orgId, dto);
  }
}
