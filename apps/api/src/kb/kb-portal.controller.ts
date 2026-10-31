import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthGuard, CurrentMember, CurrentOrg, CurrentUser, RolesGuard } from "../common";
import { KbAccessService } from "./kb-access.service";
import { KbReaderService } from "./kb-reader.service";
import { KbDeflectionDto, KbFeedbackDto, KbReaderListQueryDto, KbSearchQueryDto, KbSuggestQueryDto } from "./kb.dto";

/**
 * The help center inside the portal. Any signed-in member of the workspace;
 * what they see is decided by KbAccessService.readerFor (staff read
 * published articles of every visibility, clients by the visibility rules).
 */
@Controller("kb/mine")
@UseGuards(AuthGuard, RolesGuard)
export class KbPortalController {
  constructor(
    private reader: KbReaderService,
    private access: KbAccessService,
  ) {}

  @Get("collections")
  async collections(@CurrentOrg("id") orgId: string, @CurrentUser("id") userId: string, @CurrentMember("role") role: string) {
    return this.reader.listCollections(orgId, await this.access.readerFor(userId, orgId, role));
  }

  @Get("articles")
  async articles(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @CurrentMember("role") role: string,
    @Query() query: KbReaderListQueryDto,
  ) {
    return this.reader.listArticles(orgId, await this.access.readerFor(userId, orgId, role), query);
  }

  @Get("search")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async search(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @CurrentMember("role") role: string,
    @Query() query: KbSearchQueryDto,
  ) {
    return this.reader.search(orgId, await this.access.readerFor(userId, orgId, role), query.q, { limit: query.limit ?? 20 });
  }

  /** Articles that might answer a ticket being written; called as the subject is typed. */
  @Get("suggest")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async suggest(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @CurrentMember("role") role: string,
    @Query() query: KbSuggestQueryDto,
  ) {
    return this.reader.suggest(orgId, await this.access.readerFor(userId, orgId, role), query.q, query.categoryId);
  }

  @Post("deflections")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async deflection(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @CurrentMember("role") role: string,
    @Body() dto: KbDeflectionDto,
  ) {
    const reader = await this.access.readerFor(userId, orgId, role);
    return this.reader.recordDeflection(orgId, reader, userId, dto.articleId, dto.outcome);
  }

  @Get("articles/:slug")
  async article(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @CurrentMember("role") role: string,
    @Param("slug") slug: string,
  ) {
    const reader = await this.access.readerFor(userId, orgId, role);
    return this.reader.getArticle(orgId, reader, slug, { userId, key: userId });
  }

  @Get("articles/:slug/related")
  async related(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @CurrentMember("role") role: string,
    @Param("slug") slug: string,
  ) {
    return this.reader.related(orgId, await this.access.readerFor(userId, orgId, role), slug);
  }

  @Post("articles/:slug/feedback")
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async feedback(
    @CurrentOrg("id") orgId: string,
    @CurrentUser("id") userId: string,
    @CurrentMember("role") role: string,
    @Param("slug") slug: string,
    @Body() dto: KbFeedbackDto,
  ) {
    const reader = await this.access.readerFor(userId, orgId, role);
    return this.reader.feedback(orgId, reader, slug, { userId, key: userId }, dto);
  }
}
