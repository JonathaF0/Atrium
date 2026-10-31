import {
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
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { AuthGuard, CurrentMember, CurrentOrg, CurrentUser, Roles, RolesGuard } from "../common";
import type { AuthUser } from "../common";
import { AnnouncementsService, type Actor } from "./announcements.service";
import { AnnouncementsPortalService } from "./announcements-portal.service";
import { AudienceResolver } from "./audience-resolver.service";
import {
  AnnouncementListQueryDto,
  AnnouncementUpdatePostDto,
  AudienceDto,
  CreateAnnouncementDto,
  CreateTemplateDto,
  ScheduleAnnouncementDto,
  StatusPageSettingsDto,
  UpdateAnnouncementDto,
  UpdateTemplateDto,
} from "./announcements.dto";

const PORTAL_WRITE_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

function actor(user: AuthUser, req: Request): Actor {
  return { id: user.id, email: user.email, req };
}

/**
 * Staff routes need owner/admin; `mine` routes are for portal users and derive
 * the audience server-side. Literal paths are declared before `:id`.
 */
@Controller("announcements")
@UseGuards(AuthGuard, RolesGuard)
export class AnnouncementsController {
  constructor(
    private service: AnnouncementsService,
    private portal: AnnouncementsPortalService,
    private audience: AudienceResolver,
  ) {}

  // ─── Portal ───

  @Get("mine")
  async mine(@CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string, @CurrentMember("role") role?: string) {
    return this.portal.feed(await this.audience.viewer(userId, orgId, role));
  }

  @Get("mine/banner")
  async banner(@CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string, @CurrentMember("role") role?: string) {
    return this.portal.banner(await this.audience.viewer(userId, orgId, role));
  }

  @Get("mine/unread-count")
  async unread(@CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string, @CurrentMember("role") role?: string) {
    return { count: await this.portal.unreadCount(await this.audience.viewer(userId, orgId, role)) };
  }

  @Get("mine/for-category/:categoryId")
  async forCategory(
    @Param("categoryId") categoryId: string,
    @CurrentUser("id") userId: string,
    @CurrentOrg("id") orgId: string,
    @CurrentMember("role") role?: string,
  ) {
    return this.portal.forCategory(await this.audience.viewer(userId, orgId, role), categoryId.slice(0, 64));
  }

  @Post("mine/:id/read")
  @HttpCode(204)
  @Throttle(PORTAL_WRITE_THROTTLE)
  async read(
    @Param("id") id: string,
    @CurrentUser("id") userId: string,
    @CurrentOrg("id") orgId: string,
    @CurrentMember("role") role?: string,
  ): Promise<void> {
    await this.portal.markRead(await this.audience.viewer(userId, orgId, role), id);
  }

  @Post("mine/:id/dismiss")
  @HttpCode(204)
  @Throttle(PORTAL_WRITE_THROTTLE)
  async dismiss(
    @Param("id") id: string,
    @CurrentUser("id") userId: string,
    @CurrentOrg("id") orgId: string,
    @CurrentMember("role") role?: string,
  ): Promise<void> {
    await this.portal.dismiss(await this.audience.viewer(userId, orgId, role), id);
  }

  // ─── Staff: workspace-level ───

  @Get("settings")
  @Roles("owner", "admin")
  settings(@CurrentOrg("id") orgId: string) {
    return this.service.statusSettings(orgId);
  }

  @Put("settings")
  @Roles("owner")
  updateSettings(
    @CurrentOrg("id") orgId: string,
    @Body() dto: StatusPageSettingsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.service.updateStatusSettings(orgId, dto.statusPageEnabled, actor(user, req));
  }

  @Post("audience-preview")
  @HttpCode(200)
  @Roles("owner", "admin")
  preview(@CurrentOrg("id") orgId: string, @Body() dto: AudienceDto) {
    return this.service.preview(orgId, dto);
  }

  @Get("templates")
  @Roles("owner", "admin")
  templates(@CurrentOrg("id") orgId: string) {
    return this.service.listTemplates(orgId);
  }

  @Post("templates")
  @Roles("owner", "admin")
  createTemplate(@CurrentOrg("id") orgId: string, @Body() dto: CreateTemplateDto) {
    return this.service.createTemplate(orgId, dto);
  }

  @Put("templates/:templateId")
  @Roles("owner", "admin")
  updateTemplate(@CurrentOrg("id") orgId: string, @Param("templateId") id: string, @Body() dto: UpdateTemplateDto) {
    return this.service.updateTemplate(orgId, id, dto);
  }

  @Delete("templates/:templateId")
  @HttpCode(204)
  @Roles("owner", "admin")
  async removeTemplate(@CurrentOrg("id") orgId: string, @Param("templateId") id: string): Promise<void> {
    await this.service.removeTemplate(orgId, id);
  }

  // ─── Staff: announcements ───

  @Get()
  @Roles("owner", "admin")
  list(@CurrentOrg("id") orgId: string, @Query() query: AnnouncementListQueryDto) {
    return this.service.list(orgId, query);
  }

  @Post()
  @Roles("owner", "admin")
  create(
    @CurrentOrg("id") orgId: string,
    @Body() dto: CreateAnnouncementDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.service.create(orgId, actor(user, req), dto);
  }

  @Get(":id")
  @Roles("owner", "admin")
  get(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    return this.service.get(orgId, id);
  }

  @Put(":id")
  @Roles("owner", "admin")
  update(
    @CurrentOrg("id") orgId: string,
    @Param("id") id: string,
    @Body() dto: UpdateAnnouncementDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.service.update(orgId, id, actor(user, req), dto);
  }

  @Delete(":id")
  @HttpCode(204)
  @Roles("owner", "admin")
  async remove(
    @CurrentOrg("id") orgId: string,
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.remove(orgId, id, actor(user, req));
  }

  @Post(":id/publish")
  @HttpCode(200)
  @Roles("owner", "admin")
  publish(@CurrentOrg("id") orgId: string, @Param("id") id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.service.publish(orgId, id, actor(user, req));
  }

  @Post(":id/schedule")
  @HttpCode(200)
  @Roles("owner", "admin")
  schedule(
    @CurrentOrg("id") orgId: string,
    @Param("id") id: string,
    @Body() dto: ScheduleAnnouncementDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.service.schedule(orgId, id, actor(user, req), new Date(dto.publishAt));
  }

  @Post(":id/unpublish")
  @HttpCode(200)
  @Roles("owner", "admin")
  unpublish(@CurrentOrg("id") orgId: string, @Param("id") id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.service.unpublish(orgId, id, actor(user, req));
  }

  @Post(":id/expire")
  @HttpCode(200)
  @Roles("owner", "admin")
  expire(@CurrentOrg("id") orgId: string, @Param("id") id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.service.expire(orgId, id, actor(user, req));
  }

  @Post(":id/updates")
  @Roles("owner", "admin")
  postUpdate(
    @CurrentOrg("id") orgId: string,
    @Param("id") id: string,
    @Body() dto: AnnouncementUpdatePostDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.service.postUpdate(orgId, id, actor(user, req), dto);
  }

  @Get(":id/tickets")
  @Roles("owner", "admin")
  tickets(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    return this.service.listTickets(orgId, id);
  }

  @Post(":id/tickets/:ticketId")
  @HttpCode(204)
  @Roles("owner", "admin")
  async linkTicket(
    @CurrentOrg("id") orgId: string,
    @Param("id") id: string,
    @Param("ticketId") ticketId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.linkTicket(orgId, id, ticketId, actor(user, req));
  }

  @Delete(":id/tickets/:ticketId")
  @HttpCode(204)
  @Roles("owner", "admin")
  async unlinkTicket(
    @CurrentOrg("id") orgId: string,
    @Param("id") id: string,
    @Param("ticketId") ticketId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.unlinkTicket(orgId, id, ticketId, actor(user, req));
  }
}
