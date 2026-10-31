import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { AutomationRule, BusinessHoliday, BusinessHours, SlaPolicy } from "@atrium/database";
import { AuthGuard, CurrentOrg, CurrentUser, Roles, RolesGuard } from "../common";
import { HelpdeskSettingsService } from "./helpdesk-settings.service";
import { CannedResponsesService } from "./canned-responses.service";
import { AutomationService } from "./automation.service";
import {
  AutomationRuleDto,
  BusinessHoursDto,
  CannedResponseDto,
  CategoryDto,
  CompanyAdminDto,
  HelpdeskSettingsDto,
  HolidayDto,
  InboundSettingsDto,
  RenderCannedDto,
  SlaPolicyDto,
  UpdateAutomationRuleDto,
  UpdateBusinessHoursDto,
  UpdateCannedResponseDto,
  UpdateCategoryDto,
  UpdateSlaPolicyDto,
} from "./helpdesk.dto";

/** Helpdesk configuration (owners and admins). Rotating the inbound secret is owner-only. */
@Controller("helpdesk")
@UseGuards(AuthGuard, RolesGuard)
@Roles("owner", "admin")
export class HelpdeskSettingsController {
  constructor(
    private settings: HelpdeskSettingsService,
    private canned: CannedResponsesService,
    private automation: AutomationService,
  ) {}

  @Get("settings")
  get(@CurrentOrg("id") orgId: string) {
    return this.settings.get(orgId);
  }

  @Patch("settings")
  update(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: HelpdeskSettingsDto, @Req() req: Request) {
    return this.settings.update(orgId, userId, dto, req);
  }

  @Get("staff")
  staff(@CurrentOrg("id") orgId: string) {
    return this.settings.staff(orgId);
  }

  @Put("contacts/:contactId/company-admin")
  setCompanyAdmin(
    @Param("contactId") contactId: string,
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Body() dto: CompanyAdminDto,
    @Req() req: Request,
  ) {
    return this.settings.setCompanyAdmin(orgId, contactId, userId, dto.companyAdmin, req);
  }

  // ─── Inbound ───

  @Patch("inbound")
  updateInbound(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: InboundSettingsDto, @Req() req: Request) {
    return this.settings.updateInbound(orgId, userId, dto, req);
  }

  @Post("inbound/secret")
  @Roles("owner")
  rotateSecret(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Req() req: Request) {
    return this.settings.rotateWebhookSecret(orgId, userId, req);
  }

  @Post("inbound/test-imap")
  testImap(@CurrentOrg("id") orgId: string) {
    return this.settings.testImap(orgId);
  }

  // ─── Categories ───

  @Get("categories")
  categories(@CurrentOrg("id") orgId: string) {
    return this.settings.listCategories(orgId);
  }

  @Post("categories")
  createCategory(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: CategoryDto) {
    return this.settings.createCategory(orgId, userId, dto);
  }

  @Patch("categories/:id")
  updateCategory(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: UpdateCategoryDto) {
    return this.settings.updateCategory(orgId, id, userId, dto);
  }

  @Delete("categories/:id")
  removeCategory(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string) {
    return this.settings.removeCategory(orgId, id, userId);
  }

  // ─── SLA ───

  @Get("sla-policies")
  policies(@CurrentOrg("id") orgId: string): Promise<(SlaPolicy & { businessHours: { id: string; name: string } | null })[]> {
    return this.settings.listPolicies(orgId);
  }

  @Post("sla-policies")
  createPolicy(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: SlaPolicyDto): Promise<SlaPolicy> {
    return this.settings.createPolicy(orgId, userId, dto);
  }

  @Patch("sla-policies/:id")
  updatePolicy(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: UpdateSlaPolicyDto): Promise<SlaPolicy> {
    return this.settings.updatePolicy(orgId, id, userId, dto);
  }

  @Delete("sla-policies/:id")
  removePolicy(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string) {
    return this.settings.removePolicy(orgId, id, userId);
  }

  @Get("business-hours")
  calendars(@CurrentOrg("id") orgId: string): Promise<(BusinessHours & { holidays: BusinessHoliday[] })[]> {
    return this.settings.listCalendars(orgId);
  }

  @Post("business-hours")
  createCalendar(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: BusinessHoursDto): Promise<BusinessHours> {
    return this.settings.createCalendar(orgId, userId, dto);
  }

  @Put("business-hours/:id")
  updateCalendar(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: UpdateBusinessHoursDto): Promise<BusinessHours> {
    return this.settings.updateCalendar(orgId, id, userId, dto);
  }

  @Delete("business-hours/:id")
  removeCalendar(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string) {
    return this.settings.removeCalendar(orgId, id, userId);
  }

  @Post("business-hours/:id/holidays")
  addHoliday(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: HolidayDto) {
    return this.settings.addHoliday(orgId, id, userId, dto);
  }

  @Delete("business-hours/:id/holidays/:holidayId")
  removeHoliday(@Param("id") id: string, @Param("holidayId") holidayId: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string) {
    return this.settings.removeHoliday(orgId, id, holidayId, userId);
  }

  // ─── Canned responses ───

  @Get("canned-responses")
  cannedList(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string) {
    return this.canned.list(orgId, userId);
  }

  @Post("canned-responses")
  cannedCreate(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: CannedResponseDto) {
    return this.canned.create(orgId, userId, dto);
  }

  @Patch("canned-responses/:id")
  cannedUpdate(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: UpdateCannedResponseDto) {
    return this.canned.update(orgId, userId, id, dto);
  }

  @Delete("canned-responses/:id")
  async cannedRemove(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string) {
    await this.canned.remove(orgId, userId, id);
    return { ok: true };
  }

  @Post("canned-responses/:id/render")
  cannedRender(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: RenderCannedDto) {
    return this.canned.render(orgId, userId, id, dto.ticketId);
  }

  // ─── Automation ───

  @Get("automation-rules")
  rules(@CurrentOrg("id") orgId: string): Promise<AutomationRule[]> {
    return this.automation.list(orgId);
  }

  @Post("automation-rules")
  createRule(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: AutomationRuleDto): Promise<AutomationRule> {
    return this.automation.create(orgId, userId, dto);
  }

  @Patch("automation-rules/:id")
  updateRule(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: UpdateAutomationRuleDto): Promise<AutomationRule> {
    return this.automation.update(orgId, id, userId, dto);
  }

  @Delete("automation-rules/:id")
  async removeRule(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string) {
    await this.automation.remove(orgId, id, userId);
    return { ok: true };
  }
}
