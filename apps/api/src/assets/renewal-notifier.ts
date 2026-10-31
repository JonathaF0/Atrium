import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma } from "@atrium/database";
import { RenewalNoticeEmail } from "@atrium/email";
import { PrismaService } from "../prisma/prisma.service";
import { InAppNotificationsService } from "../notifications/in-app-notifications.service";
import { MailService } from "../mail/mail.service";
import { EmailRenderer } from "../mail/email-renderer";

export const MAX_EMAIL_ITEMS = 25;

export interface StaffRecipient {
  userId: string;
  email: string;
}

export interface RenewalDigest {
  /** In-app notification type, e.g. "asset_renewal". */
  type: string;
  title: string;
  message: string;
  /** Dashboard path the in-app notification and the email button open. */
  link: string;
  subject: string;
  heading: string;
  intro: string;
  listLabel: string;
  items: Array<{ title: string; detail: string; path: string }>;
}

export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Sends renewal digests (asset warranties/licenses, contracts) to a workspace's owners and admins. */
@Injectable()
export class RenewalNotifier {
  private readonly logger = new Logger(RenewalNotifier.name);

  constructor(
    private prisma: PrismaService,
    private inApp: InAppNotificationsService,
    private mail: MailService,
    private config: ConfigService,
    private renderer: EmailRenderer,
  ) {}

  async staff(organizationId: string): Promise<StaffRecipient[]> {
    const rows = await this.prisma.member.findMany({
      where: { organizationId, role: { in: ["owner", "admin"] } },
      select: { userId: true, user: { select: { email: true } } },
    });
    return rows.map((r) => ({ userId: r.userId, email: r.user.email }));
  }

  /** One in-app notification per recipient; written inside the caller's claim transaction. */
  async inAppDigest(
    organizationId: string,
    recipients: StaffRecipient[],
    digest: RenewalDigest,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await this.inApp.createMany(
      recipients.map((r) => ({
        userId: r.userId,
        organizationId,
        type: digest.type,
        title: digest.title.slice(0, 200),
        message: digest.message.slice(0, 500),
        link: digest.link,
      })),
      tx,
    );
  }

  /** One email per recipient. Failures are logged; the notice is not retried. */
  async emailDigest(organizationId: string, recipients: StaffRecipient[], digest: RenewalDigest): Promise<number> {
    if (recipients.length === 0) return 0;
    const webUrl: string = this.config.get("WEB_URL", "http://localhost:3000").replace(/\/+$/, "");
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    let sent = 0;
    try {
      const html: string = await this.renderer.render(
        RenewalNoticeEmail({
          organizationName: org?.name ?? "your workspace",
          heading: digest.heading,
          intro: digest.intro,
          items: digest.items.slice(0, MAX_EMAIL_ITEMS).map((i) => ({ title: i.title, detail: i.detail, url: `${webUrl}${i.path}` })),
          moreCount: Math.max(0, digest.items.length - MAX_EMAIL_ITEMS),
          listUrl: `${webUrl}${digest.link}`,
          listLabel: digest.listLabel,
        }),
      );
      for (const r of recipients) {
        try {
          const res = await this.mail.send(r.email, digest.subject, html, organizationId);
          if (res.sent) sent++;
        } catch (err) {
          this.logger.error(`Renewal email failed for org ${organizationId}`, err);
        }
      }
    } catch (err) {
      this.logger.error(`Renewal email render failed for org ${organizationId}`, err);
    }
    return sent;
  }
}
