import { createHash } from "crypto";
import { Body, Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { ConfigService } from "@nestjs/config";
import { Public } from "../common";
import { AttachmentStorageService } from "../service-core";
import { KbAccessService } from "./kb-access.service";
import { KbReaderService } from "./kb-reader.service";
import type { KbVoter } from "./kb-reader.service";
import type { KbReader } from "./kb-visibility";
import { KbFeedbackDto, KbReaderListQueryDto, KbSearchQueryDto } from "./kb.dto";
import { sendKbAttachment } from "./kb-attachment-response";

const ANONYMOUS: KbReader = { kind: "anonymous" };

/**
 * The public help center. Every route 404s unless the workspace has turned it
 * on, and only `public` articles in fully public collections are served.
 */
@Controller("kb/public/:orgSlug")
@Public()
@Throttle({ default: { limit: 60, ttl: 60000 } })
export class KbPublicController {
  private readonly salt: string;

  constructor(
    private reader: KbReaderService,
    private access: KbAccessService,
    private storage: AttachmentStorageService,
    config: ConfigService,
  ) {
    this.salt = config.get<string>("BETTER_AUTH_SECRET", "");
  }

  /** Anonymous readers are told apart by a salted hash of IP + user agent; neither is stored. */
  private voter(req: Request): KbVoter {
    const ua: string = String(req.headers["user-agent"] ?? "").slice(0, 500);
    const key: string = createHash("sha256").update(`${this.salt}|${req.ip ?? ""}|${ua}`).digest("hex");
    return { userId: null, key: `anon:${key}` };
  }

  @Get()
  async info(@Param("orgSlug") orgSlug: string) {
    const org = await this.access.publicOrg(orgSlug);
    return { name: org.name, slug: org.slug };
  }

  @Get("collections")
  async collections(@Param("orgSlug") orgSlug: string) {
    const org = await this.access.publicOrg(orgSlug);
    return this.reader.listCollections(org.id, ANONYMOUS);
  }

  @Get("articles")
  async articles(@Param("orgSlug") orgSlug: string, @Query() query: KbReaderListQueryDto) {
    const org = await this.access.publicOrg(orgSlug);
    return this.reader.listArticles(org.id, ANONYMOUS, query);
  }

  @Get("search")
  async search(@Param("orgSlug") orgSlug: string, @Query() query: KbSearchQueryDto) {
    const org = await this.access.publicOrg(orgSlug);
    return this.reader.search(org.id, ANONYMOUS, query.q, { limit: Math.min(query.limit ?? 20, 20) });
  }

  @Get("articles/:slug")
  async article(@Param("orgSlug") orgSlug: string, @Param("slug") slug: string, @Req() req: Request) {
    const org = await this.access.publicOrg(orgSlug);
    return this.reader.getArticle(org.id, ANONYMOUS, slug, this.voter(req));
  }

  @Get("articles/:slug/related")
  async related(@Param("orgSlug") orgSlug: string, @Param("slug") slug: string) {
    const org = await this.access.publicOrg(orgSlug);
    return this.reader.related(org.id, ANONYMOUS, slug);
  }

  @Post("articles/:slug/feedback")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async feedback(
    @Param("orgSlug") orgSlug: string,
    @Param("slug") slug: string,
    @Body() dto: KbFeedbackDto,
    @Req() req: Request,
  ) {
    const org = await this.access.publicOrg(orgSlug);
    // Comments from anonymous visitors are not stored.
    return this.reader.feedback(org.id, ANONYMOUS, slug, this.voter(req), { helpful: dto.helpful });
  }

  @Get("attachments/:id")
  async attachment(@Param("orgSlug") orgSlug: string, @Param("id") id: string, @Res() res: Response): Promise<void> {
    const org = await this.access.publicOrg(orgSlug);
    await sendKbAttachment(res, await this.reader.attachment(org.id, ANONYMOUS, id), this.storage, "public, max-age=300");
  }
}
