import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { AuthGuard, CurrentOrg, CurrentUser, PaginationQueryDto, Roles, RolesGuard, contentDisposition } from "../common";
import type { AuthenticatedRequest } from "../common";
import { PrismaService } from "../prisma/prisma.service";
import { AiDraftService } from "./ai-draft.service";
import { EstimateConversionService } from "./estimate-conversion.service";
import { EstimatePdfService } from "./estimate-pdf.service";
import { EstimatesPortalService } from "./estimates-portal.service";
import { EstimatesService } from "./estimates.service";
import {
  AcceptEstimateDto,
  AiDraftDto,
  ConvertEstimateDto,
  DeclineEstimateDto,
  EstimateBodyDto,
  EstimateCommentDto,
  EstimateListQueryDto,
  EstimateSettingsDto,
  ToggleOptionDto,
  UpdateEstimateDto,
} from "./estimates.dto";

const PORTAL_WRITE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@Controller("estimates")
@UseGuards(AuthGuard, RolesGuard)
export class EstimatesController {
  constructor(
    private estimates: EstimatesService,
    private portal: EstimatesPortalService,
    private conversion: EstimateConversionService,
    private pdf: EstimatePdfService,
    private ai: AiDraftService,
    private prisma: PrismaService,
  ) {}

  private viewer(req: AuthenticatedRequest) {
    return { userId: req.user.id, orgId: req.organization.id, preview: !!req.previewMode, req };
  }

  private sendPdf(res: Response, buffer: Buffer, filename: string): void {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDisposition(filename));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buffer);
  }

  // ─── Portal (the session user's own estimates; scope is derived server-side) ───

  @Get("mine")
  listMine(@CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string, @Query() q: PaginationQueryDto) {
    return this.portal.listMine(userId, orgId, q);
  }

  @Get("mine/count")
  countMine(@CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string) {
    return this.portal.countMine(userId, orgId);
  }

  @Get("mine/:id")
  getMine(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.portal.getMine(this.viewer(req), id);
  }

  @Get("mine/:id/pdf")
  async pdfMine(@Param("id") id: string, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const estimate = await this.portal.loadForPdf(this.viewer(req), id);
    const buffer = await this.pdf.render(estimate, { withAcceptance: estimate.status === "accepted" || estimate.status === "converted" });
    this.sendPdf(res, buffer, `${estimate.number}.pdf`);
  }

  @Post("mine/:id/options")
  @Throttle(PORTAL_WRITE_THROTTLE)
  toggleOption(@Param("id") id: string, @Body() dto: ToggleOptionDto, @Req() req: AuthenticatedRequest) {
    return this.portal.toggleOption(this.viewer(req), id, dto);
  }

  @Post("mine/:id/comments")
  @Throttle(PORTAL_WRITE_THROTTLE)
  commentMine(@Param("id") id: string, @Body() dto: EstimateCommentDto, @Req() req: AuthenticatedRequest) {
    return this.portal.comment(this.viewer(req), id, dto);
  }

  @Post("mine/:id/request-changes")
  @Throttle(PORTAL_WRITE_THROTTLE)
  requestChanges(@Param("id") id: string, @Body() dto: EstimateCommentDto, @Req() req: AuthenticatedRequest) {
    return this.portal.requestChanges(this.viewer(req), id, dto);
  }

  @Post("mine/:id/decline")
  @Throttle(PORTAL_WRITE_THROTTLE)
  decline(@Param("id") id: string, @Body() dto: DeclineEstimateDto, @Req() req: AuthenticatedRequest) {
    return this.portal.decline(this.viewer(req), id, dto);
  }

  @Post("mine/:id/accept")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  accept(@Param("id") id: string, @Body() dto: AcceptEstimateDto, @Req() req: AuthenticatedRequest) {
    return this.portal.accept(this.viewer(req), id, dto);
  }

  // ─── Staff ───

  @Get()
  @Roles("owner", "admin")
  list(@CurrentOrg("id") orgId: string, @Query() q: EstimateListQueryDto) {
    return this.estimates.list(orgId, q);
  }

  @Get("settings")
  @Roles("owner", "admin")
  async getSettings(@CurrentOrg("id") orgId: string) {
    return { ...(await this.estimates.getSettings(orgId)), aiServerConfigured: this.ai.serverConfigured() };
  }

  @Put("settings")
  @Roles("owner", "admin")
  async updateSettings(@CurrentOrg("id") orgId: string, @Body() dto: EstimateSettingsDto) {
    return { ...(await this.estimates.updateSettings(orgId, dto)), aiServerConfigured: this.ai.serverConfigured() };
  }

  /** Companies and portal clients that can receive an estimate. */
  @Get("clients")
  @Roles("owner", "admin")
  async clients(@CurrentOrg("id") orgId: string) {
    const [companies, members, contacts] = await Promise.all([
      this.prisma.company.findMany({ where: { organizationId: orgId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 1000 }),
      this.prisma.member.findMany({
        where: { organizationId: orgId, role: "member" },
        select: { userId: true, user: { select: { name: true, email: true } } },
        take: 2000,
      }),
      this.prisma.contact.findMany({
        where: { organizationId: orgId, userId: { not: null } },
        select: { userId: true, companyId: true },
      }),
    ]);
    const companyOf = new Map(contacts.map((c) => [c.userId!, c.companyId]));
    return {
      companies,
      recipients: members
        .map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, companyId: companyOf.get(m.userId) ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  @Get("ai-draft/status")
  @Roles("owner", "admin")
  aiStatus(@CurrentOrg("id") orgId: string) {
    return this.ai.status(orgId);
  }

  @Post("ai-draft")
  @Roles("owner", "admin")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  aiDraft(@CurrentOrg("id") orgId: string, @Body() dto: AiDraftDto) {
    return this.ai.draft(orgId, dto);
  }

  @Post()
  @Roles("owner", "admin")
  create(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Body() dto: EstimateBodyDto) {
    return this.estimates.create(orgId, userId, dto);
  }

  @Get(":id")
  @Roles("owner", "admin")
  get(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    return this.estimates.get(orgId, id);
  }

  @Put(":id")
  @Roles("owner", "admin")
  update(@CurrentOrg("id") orgId: string, @Param("id") id: string, @Body() dto: UpdateEstimateDto) {
    return this.estimates.update(orgId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  async remove(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await this.estimates.remove(orgId, id, userId, req);
    return { ok: true };
  }

  @Post(":id/send")
  @Roles("owner", "admin")
  send(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.estimates.send(orgId, id, userId, req);
  }

  @Post(":id/duplicate")
  @Roles("owner", "admin")
  duplicate(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Param("id") id: string) {
    return this.estimates.duplicate(orgId, id, userId);
  }

  @Post(":id/revise")
  @Roles("owner", "admin")
  revise(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Param("id") id: string) {
    return this.estimates.revise(orgId, id, userId);
  }

  @Post(":id/comments")
  @Roles("owner", "admin")
  comment(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @Param("id") id: string, @Body() dto: EstimateCommentDto) {
    return this.estimates.addComment(orgId, id, userId, dto);
  }

  @Post(":id/convert")
  @Roles("owner", "admin")
  convert(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @Param("id") id: string,
    @Body() dto: ConvertEstimateDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.conversion.convert(orgId, id, userId, dto, req);
  }

  @Get(":id/pdf")
  @Roles("owner", "admin")
  async pdfStaff(@CurrentOrg("id") orgId: string, @Param("id") id: string, @Res() res: Response) {
    const estimate = await this.estimates.findRaw(orgId, id);
    const buffer = await this.pdf.render(estimate, { withAcceptance: !!estimate.acceptedName });
    this.sendPdf(res, buffer, `${estimate.number}${estimate.version > 1 ? `-v${estimate.version}` : ""}.pdf`);
  }
}
