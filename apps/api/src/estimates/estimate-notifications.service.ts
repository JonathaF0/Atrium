import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import * as Emails from "@atrium/email";
import { formatMoney } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { EmailRenderer } from "../mail/email-renderer";
import { InAppNotificationsService } from "../notifications/in-app-notifications.service";
import { PushService } from "../notifications/push.service";
import { IntegrationDispatcher } from "../integrations/integration-dispatcher.service";
import { getCurrency } from "../common/helpers/currency";

export interface EstimateRef {
  id: string;
  organizationId: string;
  number: string;
  version: number;
  title: string;
  recipientUserId: string | null;
  projectId: string | null;
  validUntil: Date | null;
}

type ClientAction = "accepted" | "declined" | "changes_requested";

const ACTION_TITLES: Record<ClientAction, string> = {
  accepted: "accepted",
  declined: "declined",
  changes_requested: "requested changes to",
};

/**
 * Email, in-app, push and integration notifications for estimates. Every
 * method is fire-and-forget: failures are logged and never reach the caller.
 */
@Injectable()
export class EstimateNotificationsService {
  private webUrl: string;

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private renderer: EmailRenderer,
    private inApp: InAppNotificationsService,
    private push: PushService,
    private integrations: IntegrationDispatcher,
    private config: ConfigService,
    @InjectPinoLogger(EstimateNotificationsService.name) private readonly logger: PinoLogger,
  ) {
    this.webUrl = this.config.get("WEB_URL", "http://localhost:3000").replace(/\/+$/, "");
  }

  private money(cents: number): string {
    return formatMoney(cents, getCurrency(this.config));
  }

  /** Estimate sent (or a revision sent) to the recipient. */
  notifySent(estimate: EstimateRef, totalCents: number, actorId: string | null): void {
    const label = estimate.version > 1 ? `${estimate.number} (v${estimate.version})` : estimate.number;
    this.integrations.dispatch({
      event: "estimate.sent",
      organizationId: estimate.organizationId,
      projectId: estimate.projectId,
      actorId,
      title: `Estimate ${label} sent`,
      detail: `${estimate.title} · ${this.money(totalCents)}`,
      data: { estimateId: estimate.id, number: estimate.number, version: estimate.version, totalCents },
      path: `/dashboard/estimates/${estimate.id}`,
    });
    this.toClient(estimate, totalCents, "sent").catch((err) =>
      this.logger.error({ err, estimateId: estimate.id }, "Failed to send estimate notifications"),
    );
  }

  /** Expiry reminder to the recipient. Resolves to true when an email went out. */
  async sendReminder(estimate: EstimateRef, totalCents: number): Promise<boolean> {
    try {
      return await this.toClient(estimate, totalCents, "reminder");
    } catch (err) {
      this.logger.error({ err, estimateId: estimate.id }, "Failed to send estimate reminder");
      return false;
    }
  }

  private async toClient(estimate: EstimateRef, totalCents: number, kind: "sent" | "reminder"): Promise<boolean> {
    if (!estimate.recipientUserId) return false;
    const [user, org] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: estimate.recipientUserId }, select: { id: true, name: true, email: true } }),
      this.prisma.organization.findUnique({ where: { id: estimate.organizationId }, select: { name: true } }),
    ]);
    if (!user) return false;
    const link = `/portal/estimates/${estimate.id}`;
    const amount = this.money(totalCents);
    const title = kind === "reminder" ? `Estimate ${estimate.number} expires soon` : `New estimate: ${estimate.title}`;
    this.inAppAndPush([user.id], estimate.organizationId, "estimate", title, `${estimate.number} · ${amount}`, link);

    const html = await this.renderer.render(
      Emails.EstimateSentEmail({
        clientName: user.name,
        orgName: org?.name ?? "Your provider",
        estimateNumber: estimate.number,
        title: estimate.title,
        amount,
        validUntil: estimate.validUntil ? estimate.validUntil.toLocaleDateString("en-US", { dateStyle: "medium" }) : null,
        portalUrl: `${this.webUrl}${link}`,
        kind,
      }),
    );
    const subject = kind === "reminder" ? `Reminder: estimate ${estimate.number} expires soon` : `Estimate ${estimate.number}: ${estimate.title}`;
    const res = await this.mail.send(user.email, subject, html, estimate.organizationId);
    return res.sent;
  }

  /** The client accepted, declined, or asked for changes: tell the workspace's owners and admins. */
  notifyClientAction(estimate: EstimateRef, action: ClientAction, clientName: string, message: string | null): void {
    this.integrations.dispatch({
      event: `estimate.${action}`,
      organizationId: estimate.organizationId,
      projectId: estimate.projectId,
      actorName: clientName,
      title: `${clientName} ${ACTION_TITLES[action]} estimate ${estimate.number}`,
      detail: message ? message.slice(0, 500) : estimate.title,
      data: { estimateId: estimate.id, number: estimate.number, version: estimate.version },
      path: `/dashboard/estimates/${estimate.id}`,
    });
    this.toStaff(estimate, action, clientName, message).catch((err) =>
      this.logger.error({ err, estimateId: estimate.id }, "Failed to send estimate response notifications"),
    );
  }

  /** A client comment on an estimate (without a status change). */
  notifyClientComment(estimate: EstimateRef, clientName: string): void {
    this.staffIds(estimate.organizationId)
      .then((ids) =>
        this.inAppAndPush(
          ids,
          estimate.organizationId,
          "estimate",
          `${clientName} commented on estimate ${estimate.number}`,
          estimate.title,
          `/dashboard/estimates/${estimate.id}`,
        ),
      )
      .catch((err) => this.logger.warn({ err }, "Failed to notify staff of estimate comment"));
  }

  /** A staff comment: tell the recipient in-app. */
  notifyStaffComment(estimate: EstimateRef): void {
    if (!estimate.recipientUserId) return;
    this.inAppAndPush(
      [estimate.recipientUserId],
      estimate.organizationId,
      "estimate",
      `New comment on estimate ${estimate.number}`,
      estimate.title,
      `/portal/estimates/${estimate.id}`,
    );
  }

  private async staffIds(orgId: string): Promise<string[]> {
    const admins = await this.prisma.member.findMany({
      where: { organizationId: orgId, role: { in: ["owner", "admin"] } },
      select: { userId: true },
    });
    return admins.map((a) => a.userId);
  }

  private async toStaff(estimate: EstimateRef, action: ClientAction, clientName: string, message: string | null): Promise<void> {
    const admins = await this.prisma.member.findMany({
      where: { organizationId: estimate.organizationId, role: { in: ["owner", "admin"] } },
      select: { userId: true, user: { select: { name: true, email: true } } },
    });
    if (admins.length === 0) return;
    const link = `/dashboard/estimates/${estimate.id}`;
    const title = `${clientName} ${ACTION_TITLES[action]} estimate ${estimate.number}`;
    this.inAppAndPush(admins.map((a) => a.userId), estimate.organizationId, "estimate", title, estimate.title, link);
    await Promise.allSettled(
      admins.map(async (a) => {
        const html = await this.renderer.render(
          Emails.EstimateRespondedEmail({
            recipientName: a.user.name,
            clientName,
            estimateNumber: estimate.number,
            title: estimate.title,
            action,
            message,
            dashboardUrl: `${this.webUrl}${link}`,
          }),
        );
        await this.mail.send(a.user.email, title, html, estimate.organizationId);
      }),
    );
  }

  private inAppAndPush(userIds: string[], orgId: string, type: string, title: string, message: string, link: string): void {
    if (userIds.length === 0) return;
    this.inApp
      .createMany(userIds.map((userId) => ({ userId, organizationId: orgId, type, title, message, link })))
      .catch((err) => this.logger.warn({ err }, "Failed to create in-app notifications"));
    this.push
      .sendToMany(userIds, orgId, { title, message, link })
      .catch((err) => this.logger.warn({ err }, "Failed to send push notifications"));
  }
}
