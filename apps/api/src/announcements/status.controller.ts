import { Controller, Get, Injectable, NotFoundException, Param, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { Public } from "../common";
import { STATUS_HISTORY_DAYS, buildStatusPage, type StatusPage } from "./status-page";
import { buildRss } from "./rss";

const PUBLIC_THROTTLE = { default: { limit: 30, ttl: 60_000 } };
const SLUG_MAX = 100;

@Injectable()
export class StatusPageService {
  private readonly webUrl: string;

  constructor(
    private prisma: PrismaService,
    config: ConfigService,
  ) {
    this.webUrl = config.get("WEB_URL", "http://localhost:3000").replace(/\/+$/, "");
  }

  /** null when the workspace is unknown or has the page switched off; callers answer both with the same 404. */
  async load(slug: string, now: Date = new Date()): Promise<{ org: { name: string; slug: string }; page: StatusPage } | null> {
    if (!slug || slug.length > SLUG_MAX) return null;
    const org = await this.prisma.organization.findUnique({ where: { slug }, select: { id: true, name: true, slug: true } });
    if (!org?.slug) return null;
    const settings = await this.prisma.serviceSettings.findUnique({
      where: { organizationId: org.id },
      select: { statusPageEnabled: true },
    });
    if (!settings?.statusPageEnabled) return null;

    const since = new Date(now.getTime() - STATUS_HISTORY_DAYS * 86_400_000);
    const rows = await this.prisma.announcement.findMany({
      where: {
        organizationId: org.id,
        publicStatus: true,
        audienceType: "all",
        OR: [{ status: "published" }, { status: "expired", publishedAt: { gte: since } }],
      },
      select: {
        id: true,
        type: true,
        severity: true,
        status: true,
        incidentState: true,
        title: true,
        body: true,
        impact: true,
        windowStart: true,
        windowEnd: true,
        publishedAt: true,
        resolvedAt: true,
        postmortem: true,
        publicStatus: true,
        audienceType: true,
        updates: { orderBy: { createdAt: "asc" }, select: { state: true, body: true, createdAt: true } },
      },
      orderBy: { publishedAt: "desc" },
      take: 200,
    });
    return { org: { name: org.name, slug: org.slug }, page: buildStatusPage(rows, now) };
  }

  rss(org: { name: string; slug: string }, page: StatusPage): string {
    const items = [...page.activeIncidents, ...page.maintenance, ...page.history];
    return buildRss(
      {
        title: `${org.name} service status`,
        link: `${this.webUrl}/status/${encodeURIComponent(org.slug)}`,
        description: `Incidents and scheduled maintenance for ${org.name}`,
      },
      items,
    );
  }
}

/** Public status page. Off unless the owner enables it; only publicStatus announcements for everyone appear. */
@Controller("status")
@Public()
export class StatusController {
  constructor(private status: StatusPageService) {}

  @Get(":orgSlug")
  @Throttle(PUBLIC_THROTTLE)
  async page(@Param("orgSlug") slug: string, @Res({ passthrough: true }) res: Response) {
    const loaded = await this.status.load(slug);
    if (!loaded) throw new NotFoundException("Status page not found");
    res.setHeader("Cache-Control", "public, max-age=60");
    return { org: loaded.org, ...loaded.page };
  }

  @Get(":orgSlug/rss")
  @Throttle(PUBLIC_THROTTLE)
  async rss(@Param("orgSlug") slug: string, @Res() res: Response): Promise<void> {
    const loaded = await this.status.load(slug);
    if (!loaded) throw new NotFoundException("Status page not found");
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(this.status.rss(loaded.org, loaded.page));
  }
}
