import * as Sentry from "@sentry/nestjs";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AnnouncementEmail } from "@atrium/email";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { EmailRenderer } from "../mail/email-renderer";
import { InAppNotificationsService } from "../notifications/in-app-notifications.service";
import { PushService } from "../notifications/push.service";
import { IntegrationDispatcher } from "../integrations/integration-dispatcher.service";
import { excerpt, markdownToPlainText } from "../service-core";
import { AudienceResolver, type AudienceSource } from "./audience-resolver.service";

export const TYPE_LABELS: Record<string, string> = {
  general: "Announcement",
  maintenance: "Scheduled maintenance",
  incident: "Service incident",
  security: "Security notice",
};

export const STATE_LABELS: Record<string, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

export interface NotifiableAnnouncement extends AudienceSource {
  id: string;
  organizationId: string;
  type: string;
  title: string;
  body: string;
  impact: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  emailOnPublish: boolean;
  pushOnPublish: boolean;
  createdById?: string | null;
}

type Kind = "published" | "update" | "reminder";

export function portalLink(id: string): string {
  return `/portal/announcements?id=${encodeURIComponent(id)}`;
}

export function formatWindow(start: Date | null, end: Date | null): string | undefined {
  if (!start) return undefined;
  const fmt = (d: Date): string =>
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    });
  return end ? `${fmt(start)} to ${fmt(end)}` : fmt(start);
}

/**
 * Delivers announcements to their audience: in-app (the bell) always, email and
 * web push when the announcement opted in, plus integration events for staff.
 * Recipients always come from AudienceResolver. Never throws.
 */
@Injectable()
export class AnnouncementNotificationsService {
  private readonly webUrl: string;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private mail: MailService,
    private renderer: EmailRenderer,
    private inApp: InAppNotificationsService,
    private push: PushService,
    private integrations: IntegrationDispatcher,
    private audience: AudienceResolver,
    @InjectPinoLogger(AnnouncementNotificationsService.name) private readonly logger: PinoLogger,
  ) {
    this.webUrl = this.config.get("WEB_URL", "http://localhost:3000").replace(/\/+$/, "");
  }

  async published(a: NotifiableAnnouncement, actorId?: string | null): Promise<number> {
    this.integrations.dispatch({
      event: "announcement.published",
      organizationId: a.organizationId,
      projectId: null,
      actorId: actorId ?? null,
      actorName: actorId ? undefined : "Scheduler",
      title: `${TYPE_LABELS[a.type] ?? "Announcement"} published: ${a.title}`,
      detail: excerpt(a.body, 300),
      data: { announcementId: a.id, type: a.type, audienceType: a.audienceType },
      path: `/dashboard/announcements/${a.id}`,
    });
    return this.deliver(a, "published", {
      title: `${TYPE_LABELS[a.type] ?? "Announcement"}: ${a.title}`,
      message: excerpt(a.body, 140),
    });
  }

  async updated(
    a: NotifiableAnnouncement,
    update: { body: string; state: string | null },
    actorId: string | null,
    notifyExternally: boolean,
  ): Promise<number> {
    const stateLabel = update.state ? STATE_LABELS[update.state] : undefined;
    this.integrations.dispatch({
      event: "announcement.updated",
      organizationId: a.organizationId,
      projectId: null,
      actorId,
      title: `${a.title}${stateLabel ? ` is ${stateLabel.toLowerCase()}` : " updated"}`,
      detail: excerpt(update.body, 300),
      data: { announcementId: a.id, state: update.state },
      path: `/dashboard/announcements/${a.id}`,
    });
    const delivery = notifyExternally ? a : { ...a, emailOnPublish: false, pushOnPublish: false };
    return this.deliver(
      delivery,
      "update",
      {
        title: `${stateLabel ? `${stateLabel}: ` : "Update: "}${a.title}`,
        message: excerpt(update.body, 140),
      },
      { latestUpdate: markdownToPlainText(update.body), stateLabel },
    );
  }

  async maintenanceReminder(a: NotifiableAnnouncement): Promise<number> {
    const when = formatWindow(a.windowStart, a.windowEnd);
    return this.deliver(a, "reminder", {
      title: `Upcoming maintenance: ${a.title}`,
      message: when ? `Starts ${when}` : excerpt(a.body, 140),
    });
  }

  /** Returns how many portal users were notified in-app. */
  private async deliver(
    a: NotifiableAnnouncement,
    kind: Kind,
    note: { title: string; message: string },
    extra: { latestUpdate?: string; stateLabel?: string } = {},
  ): Promise<number> {
    let userIds: string[];
    try {
      userIds = await this.audience.recipientUserIds(a.organizationId, a);
    } catch (err) {
      this.logger.error({ err, announcementId: a.id }, "Failed to resolve announcement audience");
      return 0;
    }
    if (userIds.length === 0) return 0;
    const link = portalLink(a.id);

    await this.inApp
      .createMany(
        userIds.map((userId) => ({
          userId,
          organizationId: a.organizationId,
          type: "announcement",
          title: note.title.slice(0, 200),
          message: note.message,
          link,
        })),
      )
      .catch((err) => this.logger.warn({ err, announcementId: a.id }, "Failed to create announcement notifications"));

    if (a.pushOnPublish) {
      this.push
        .sendToMany(userIds, a.organizationId, { title: note.title, message: note.message, link })
        .catch((err) => this.logger.warn({ err, announcementId: a.id }, "Failed to send announcement push"));
    }

    if (a.emailOnPublish) {
      this.sendEmails(a, kind, userIds, link, extra).catch((err) =>
        this.logger.error({ err, announcementId: a.id }, "Failed to send announcement emails"),
      );
    }
    return userIds.length;
  }

  private async sendEmails(
    a: NotifiableAnnouncement,
    kind: Kind,
    userIds: string[],
    link: string,
    extra: { latestUpdate?: string; stateLabel?: string },
  ): Promise<void> {
    const [org, users] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: a.organizationId }, select: { name: true } }),
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { email: true, name: true } }),
    ]);
    const orgName = org?.name ?? "Your provider";
    const typeLabel = TYPE_LABELS[a.type] ?? "Announcement";
    const subjectPrefix = kind === "reminder" ? "Reminder" : kind === "update" ? "Update" : typeLabel;
    const subject = `${subjectPrefix}: ${a.title}`.slice(0, 250);
    await Promise.allSettled(
      users.map(async (user) => {
        try {
          const html = await this.renderer.render(
            AnnouncementEmail({
              recipientName: user.name,
              orgName,
              kind,
              typeLabel,
              title: a.title,
              summary: excerpt(a.body, 600),
              latestUpdate: extra.latestUpdate,
              stateLabel: extra.stateLabel,
              windowText: a.type === "maintenance" ? formatWindow(a.windowStart, a.windowEnd) : undefined,
              impact: a.impact ?? undefined,
              portalUrl: `${this.webUrl}${link}`,
            }),
          );
          await this.mail.send(user.email, subject, html, a.organizationId);
        } catch (err) {
          Sentry.captureException(err);
          this.logger.warn({ err, announcementId: a.id }, "Failed to send announcement email");
        }
      }),
    );
  }
}
