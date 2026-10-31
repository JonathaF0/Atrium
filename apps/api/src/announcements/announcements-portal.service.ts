import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { AudienceResolver, type Viewer } from "./audience-resolver.service";
import { canDismiss, isBannerWorthy, isHistory, showInBanner } from "./announcement-state";
import { portalLink } from "./announcement-notifications.service";

/** How far back the portal feed shows expired announcements and resolved incidents. */
export const FEED_HISTORY_DAYS = 90;
const FEED_LIMIT = 200;

const PORTAL_SELECT = {
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
  publishAt: true,
  publishedAt: true,
  expiresAt: true,
  resolvedAt: true,
  postmortem: true,
  reminderSentAt: true,
  categoryIds: true,
  audienceType: true,
  audienceValue: true,
  audiences: { select: { companyId: true } },
  updates: { orderBy: { createdAt: "asc" }, select: { id: true, state: true, body: true, createdAt: true } },
} satisfies Prisma.AnnouncementSelect;

type PortalRow = Prisma.AnnouncementGetPayload<{ select: typeof PORTAL_SELECT }>;

export interface PortalAnnouncement {
  id: string;
  type: string;
  severity: string;
  status: string;
  incidentState: string | null;
  title: string;
  body: string;
  impact: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  publishedAt: Date | null;
  resolvedAt: Date | null;
  postmortem: string | null;
  updates: { id: string; state: string | null; body: string; createdAt: Date }[];
  read: boolean;
  dismissed: boolean;
  canDismiss: boolean;
}

/**
 * Portal side of announcements. Every list goes through AudienceResolver, and
 * single-announcement actions 404 for anything outside the viewer's audience.
 */
@Injectable()
export class AnnouncementsPortalService {
  constructor(
    private prisma: PrismaService,
    private audience: AudienceResolver,
  ) {}

  private async visible(viewer: Viewer, where: Prisma.AnnouncementWhereInput, now: Date): Promise<PortalRow[]> {
    const rows = await this.prisma.announcement.findMany({
      where: { ...where, organizationId: viewer.organizationId },
      select: PORTAL_SELECT,
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      take: FEED_LIMIT,
    });
    return this.audience.filterVisible(viewer, rows, now);
  }

  private async states(userId: string, ids: string[]): Promise<Map<string, { dismissed: boolean }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.announcementDismissal.findMany({
      where: { userId, announcementId: { in: ids } },
      select: { announcementId: true, dismissed: true },
    });
    return new Map(rows.map((r) => [r.announcementId, { dismissed: r.dismissed }]));
  }

  private shape(row: PortalRow, state: { dismissed: boolean } | undefined): PortalAnnouncement {
    return {
      id: row.id,
      type: row.type,
      severity: row.severity,
      status: row.status,
      incidentState: row.incidentState,
      title: row.title,
      body: row.body,
      impact: row.impact,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      publishedAt: row.publishedAt,
      resolvedAt: row.resolvedAt,
      postmortem: row.postmortem,
      updates: row.updates,
      read: !!state,
      dismissed: state?.dismissed ?? false,
      canDismiss: canDismiss(row),
    };
  }

  async feed(viewer: Viewer, now: Date = new Date()): Promise<{ active: PortalAnnouncement[]; history: PortalAnnouncement[]; unread: number }> {
    const since = new Date(now.getTime() - FEED_HISTORY_DAYS * 86_400_000);
    const rows = await this.visible(
      viewer,
      { OR: [{ status: "published" }, { status: "expired", publishedAt: { gte: since } }] },
      now,
    );
    const states = await this.states(viewer.userId, rows.map((r) => r.id));
    const active: PortalAnnouncement[] = [];
    const history: PortalAnnouncement[] = [];
    let unread = 0;
    for (const row of rows) {
      const item = this.shape(row, states.get(row.id));
      if (isHistory(row)) {
        if ((row.resolvedAt ?? row.publishedAt ?? now).getTime() >= since.getTime()) history.push(item);
      } else {
        active.push(item);
      }
      if (row.status === "published" && !item.read) unread++;
    }
    return { active, history, unread };
  }

  async banner(viewer: Viewer, now: Date = new Date()): Promise<PortalAnnouncement[]> {
    const rows = await this.visible(viewer, { status: "published", type: { in: ["incident", "maintenance"] } }, now);
    const candidates = rows.filter((r) => isBannerWorthy(r, now));
    const states = await this.states(viewer.userId, candidates.map((r) => r.id));
    return candidates
      .filter((r) => showInBanner(r, states.get(r.id)?.dismissed ?? false, now))
      .map((r) => this.shape(r, states.get(r.id)));
  }

  async unreadCount(viewer: Viewer, now: Date = new Date()): Promise<number> {
    const rows = await this.visible(viewer, { status: "published" }, now);
    const states = await this.states(viewer.userId, rows.map((r) => r.id));
    return rows.filter((r) => !states.has(r.id)).length;
  }

  /** Active incidents tagged with a ticket category, for the banner on the ticket form. */
  async forCategory(viewer: Viewer, categoryId: string, now: Date = new Date()): Promise<PortalAnnouncement[]> {
    const rows = await this.visible(
      viewer,
      { status: "published", type: "incident", categoryIds: { has: categoryId } },
      now,
    );
    return rows.filter((r) => isBannerWorthy(r, now)).map((r) => this.shape(r, undefined));
  }

  private async findVisible(viewer: Viewer, id: string, now: Date): Promise<PortalRow> {
    const row = await this.prisma.announcement.findFirst({
      where: { id, organizationId: viewer.organizationId, status: { in: ["published", "expired"] } },
      select: PORTAL_SELECT,
    });
    // Outside the audience looks exactly like missing.
    if (!row || !this.audience.canSee(viewer, row, now)) throw new NotFoundException("Announcement not found");
    return row;
  }

  async markRead(viewer: Viewer, id: string, now: Date = new Date()): Promise<void> {
    await this.findVisible(viewer, id, now);
    await this.prisma.announcementDismissal.upsert({
      where: { announcementId_userId: { announcementId: id, userId: viewer.userId } },
      create: { announcementId: id, userId: viewer.userId, readAt: now },
      update: {},
    });
    await this.prisma.notification.updateMany({
      where: { userId: viewer.userId, organizationId: viewer.organizationId, link: portalLink(id), read: false },
      data: { read: true },
    });
  }

  async dismiss(viewer: Viewer, id: string, now: Date = new Date()): Promise<void> {
    const row = await this.findVisible(viewer, id, now);
    if (!canDismiss(row)) {
      throw new BadRequestException("Critical announcements stay visible until they are resolved");
    }
    await this.prisma.announcementDismissal.upsert({
      where: { announcementId_userId: { announcementId: id, userId: viewer.userId } },
      create: { announcementId: id, userId: viewer.userId, readAt: now, dismissed: true },
      update: { dismissed: true },
    });
  }
}
