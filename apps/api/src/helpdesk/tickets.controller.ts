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
import { TicketsService, type TicketActor } from "./tickets.service";
import { TicketsOpsService } from "./tickets-ops.service";
import {
  AcceptTriageDto,
  BulkTicketsDto,
  ConvertToProjectDto,
  ConvertToTaskDto,
  CreateStaffTicketDto,
  LinkTicketDto,
  MergeTicketsDto,
  SplitTicketDto,
  StaffReplyDto,
  StaffTicketQueryDto,
  TicketLabelDto,
  TicketTimeDto,
  UpdateTicketDto,
} from "./helpdesk.dto";
import { sendAttachment } from "./attachment-response";

function actorOf(user: AuthUser): TicketActor {
  return { userId: user.id, name: user.name, email: user.email };
}

/** Staff ticket routes (owners and admins). */
@Controller("tickets")
@UseGuards(AuthGuard, RolesGuard)
@Roles("owner", "admin")
export class TicketsController {
  constructor(
    private tickets: TicketsService,
    private ops: TicketsOpsService,
  ) {}

  @Get()
  list(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Query() query: StaffTicketQueryDto) {
    return this.tickets.list(orgId, userId, query);
  }

  @Post()
  create(@CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: CreateStaffTicketDto) {
    return this.tickets.createForStaff(orgId, actorOf(user), dto);
  }

  @Post("bulk")
  bulk(@CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: BulkTicketsDto, @Req() req: Request) {
    return this.ops.bulk(orgId, actorOf(user), dto, req);
  }

  @Post("from-task/:taskId")
  fromTask(@Param("taskId") taskId: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser) {
    return this.ops.fromTask(taskId, orgId, actorOf(user));
  }

  @Get("attachments/:attachmentId")
  async download(@Param("attachmentId") attachmentId: string, @CurrentOrg("id") orgId: string, @Res() res: Response) {
    sendAttachment(res, await this.tickets.downloadForStaff(attachmentId, orgId));
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentOrg("id") orgId: string) {
    return this.tickets.findOne(id, orgId);
  }

  @Patch(":id")
  update(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: UpdateTicketDto) {
    return this.tickets.update(id, orgId, actorOf(user), dto);
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Req() req: Request) {
    await this.tickets.remove(id, orgId, userId, req);
    return { ok: true };
  }

  @Post(":id/messages")
  reply(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: StaffReplyDto) {
    return this.tickets.reply(id, orgId, actorOf(user), dto);
  }

  @Post(":id/attachments")
  @UseInterceptors(TempFileInterceptor("file", MAX_UPLOAD_BYTES))
  upload(
    @Param("id") id: string,
    @Query("messageId") messageId: string,
    @UploadedFile() file: TempUploadedFile,
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    if (!messageId) throw new BadRequestException("messageId is required");
    return this.tickets.addStaffAttachment(id, orgId, userId, messageId, file);
  }

  @Post(":id/accept")
  accept(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: AcceptTriageDto, @Req() req: Request) {
    return this.tickets.acceptTriage(id, orgId, actorOf(user), dto, req);
  }

  @Post(":id/labels")
  addLabel(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: TicketLabelDto) {
    return this.tickets.addLabel(id, orgId, userId, dto.labelId);
  }

  @Delete(":id/labels/:labelId")
  removeLabel(@Param("id") id: string, @Param("labelId") labelId: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string) {
    return this.tickets.removeLabel(id, orgId, userId, labelId);
  }

  @Post(":id/links")
  link(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: LinkTicketDto) {
    return this.tickets.link(id, orgId, userId, dto.relatedTicketId, dto.type ?? "related");
  }

  @Delete(":id/links/:linkId")
  unlink(@Param("id") id: string, @Param("linkId") linkId: string, @CurrentOrg("id") orgId: string) {
    return this.tickets.unlink(id, orgId, linkId);
  }

  @Post(":id/merge")
  merge(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: MergeTicketsDto, @Req() req: Request) {
    return this.ops.merge(id, orgId, actorOf(user), dto.sourceIds, req);
  }

  @Post(":id/split")
  split(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: SplitTicketDto, @Req() req: Request) {
    return this.ops.split(id, orgId, actorOf(user), dto, req);
  }

  @Get(":id/time")
  listTime(@Param("id") id: string, @CurrentOrg("id") orgId: string) {
    return this.ops.listTime(id, orgId);
  }

  @Post(":id/time")
  logTime(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: TicketTimeDto) {
    return this.ops.logTime(id, orgId, userId, dto);
  }

  @Post(":id/convert/project")
  toProject(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: ConvertToProjectDto) {
    return this.ops.toProject(id, orgId, actorOf(user), dto);
  }

  @Post(":id/convert/task")
  toTask(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Body() dto: ConvertToTaskDto) {
    return this.ops.toTask(id, orgId, actorOf(user), dto);
  }
}
