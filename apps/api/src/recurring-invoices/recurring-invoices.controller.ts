import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { AuthGuard, CurrentOrg, CurrentUser, Roles, RolesGuard } from "../common";
import type { AuthUser } from "../common";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import {
  ConfirmCardDto,
  CreateRecurringInvoiceDto,
  RecurringListQueryDto,
  UpdateRecurringInvoiceDto,
} from "./recurring-invoices.dto";

@Controller("recurring-invoices")
@UseGuards(AuthGuard, RolesGuard)
export class RecurringInvoicesController {
  constructor(private service: RecurringInvoicesService) {}

  // ── Portal (scope derived from the session) ──

  @Get("mine")
  listMine(@CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string) {
    return this.service.listMine(userId, orgId);
  }

  @Post("mine/:id/card")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  startCardSetup(@Param("id") id: string, @CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string) {
    return this.service.startCardSetup(id, userId, orgId);
  }

  @Post("mine/:id/card/confirm")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  confirmCardSetup(
    @Param("id") id: string,
    @Body() dto: ConfirmCardDto,
    @CurrentUser() user: AuthUser,
    @CurrentOrg("id") orgId: string,
    @Req() req: Request,
  ) {
    return this.service.confirmCardSetup(id, dto.sessionId, user, orgId, req);
  }

  @Delete("mine/:id/card")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  removeCard(@Param("id") id: string, @CurrentUser() user: AuthUser, @CurrentOrg("id") orgId: string, @Req() req: Request) {
    return this.service.removeCard(id, user, orgId, req);
  }

  // ── Staff ──

  @Get()
  @Roles("owner", "admin")
  list(@CurrentOrg("id") orgId: string, @Query() query: RecurringListQueryDto) {
    return this.service.list(orgId, query);
  }

  @Get("options")
  @Roles("owner", "admin")
  options(@CurrentOrg("id") orgId: string) {
    return this.service.options(orgId);
  }

  @Post()
  @Roles("owner", "admin")
  create(@Body() dto: CreateRecurringInvoiceDto, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.service.create(dto, orgId, user, req);
  }

  @Get(":id")
  @Roles("owner", "admin")
  get(@Param("id") id: string, @CurrentOrg("id") orgId: string) {
    return this.service.get(id, orgId);
  }

  @Put(":id")
  @Roles("owner", "admin")
  update(
    @Param("id") id: string,
    @Body() dto: UpdateRecurringInvoiceDto,
    @CurrentOrg("id") orgId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.service.update(id, dto, orgId, user, req);
  }

  @Post(":id/run")
  @HttpCode(200)
  @Roles("owner", "admin")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  runNow(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser) {
    return this.service.runNow(id, orgId, user);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  remove(@Param("id") id: string, @CurrentOrg("id") orgId: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.service.remove(id, orgId, user, req);
  }
}
