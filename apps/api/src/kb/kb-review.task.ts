import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { Prisma } from "@atrium/database";
import { KbReviewDueEmail } from "@atrium/email";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { EmailRenderer } from "../mail/email-renderer";
import { InAppNotificationsService } from "../notifications/in-app-notifications.service";

const BATCH_SIZE = 1000;

interface DueArticle {
  id: string;
  organizationId: string;
  title: string;
  ownerId: string | null;
  reviewBy: Date;
}

interface StaffMember {
  userId: string;
  role: string;
  name: string;
  email: string;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Daily digest to article owners about published articles past their review
 * date. Each article is claimed by setting reviewNotifiedAt in a single
 * UPDATE ... RETURNING, so replicas running the same job never notify twice;
 * changing reviewBy clears the claim so the next due date notifies again.
 */
@Injectable()
export class KbReviewTask {
  private readonly logger = new Logger(KbReviewTask.name);
  private readonly webUrl: string;

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private renderer: EmailRenderer,
    private inApp: InAppNotificationsService,
    config: ConfigService,
  ) {
    this.webUrl = config.get("WEB_URL", "http://localhost:3000").replace(/\/+$/, "");
  }

  @Cron("17 7 * * *")
  async run(): Promise<void> {
    try {
      await this.notifyDue(new Date());
    } catch (err) {
      this.logger.error("Knowledge base review reminder run failed", err);
    }
  }

  /** Returns the number of owners notified. */
  async notifyDue(now: Date): Promise<number> {
    const candidates = await this.prisma.kbArticle.findMany({
      where: { status: "published", reviewBy: { lte: now }, reviewNotifiedAt: null },
      select: { id: true },
      orderBy: { reviewBy: "asc" },
      take: BATCH_SIZE,
    });
    if (candidates.length === 0) return 0;

    const claimed: DueArticle[] = await this.prisma.$queryRaw<DueArticle[]>`
      UPDATE "kb_article" SET "reviewNotifiedAt" = ${now}
      WHERE "id" IN (${Prisma.join(candidates.map((c) => c.id))})
        AND "reviewNotifiedAt" IS NULL AND "status" = 'published' AND "reviewBy" <= ${now}
      RETURNING "id", "organizationId", "title", "ownerId", "reviewBy"`;
    if (claimed.length === 0) return 0;

    const orgIds: string[] = [...new Set(claimed.map((a) => a.organizationId))];
    const [staff, orgs] = await Promise.all([this.loadStaff(orgIds), this.loadOrgNames(orgIds)]);

    // Group by (workspace, recipient): one digest per owner.
    const groups = new Map<string, { organizationId: string; recipient: StaffMember; articles: DueArticle[] }>();
    for (const article of claimed) {
      const members: StaffMember[] = staff.get(article.organizationId) ?? [];
      for (const recipient of this.recipients(members, article.ownerId)) {
        const key = `${article.organizationId}:${recipient.userId}`;
        const group = groups.get(key) ?? { organizationId: article.organizationId, recipient, articles: [] };
        group.articles.push(article);
        groups.set(key, group);
      }
    }

    let notified = 0;
    for (const group of groups.values()) {
      try {
        await this.notify(group.organizationId, orgs.get(group.organizationId) ?? "Your workspace", group.recipient, group.articles);
        notified++;
      } catch (err) {
        this.logger.error(`Review reminder failed for org ${group.organizationId}`, err);
      }
    }
    return notified;
  }

  private async notify(organizationId: string, organizationName: string, recipient: StaffMember, articles: DueArticle[]): Promise<void> {
    const count: number = articles.length;
    const listPath = "/dashboard/kb?review=stale";
    await this.inApp.createMany([
      {
        userId: recipient.userId,
        organizationId,
        type: "kb_review_due",
        title: count === 1 ? `Review "${articles[0].title}"` : `${count} articles are due for review`,
        message: count === 1 ? `Review was due ${formatDate(articles[0].reviewBy)}` : "Knowledge base articles you own need a review",
        link: count === 1 ? `/dashboard/kb/articles/${articles[0].id}` : listPath,
      },
    ]);
    const html: string = await this.renderer.render(
      KbReviewDueEmail({
        recipientName: recipient.name,
        organizationName,
        listUrl: `${this.webUrl}${listPath}`,
        articles: articles.map((a) => ({
          title: a.title,
          reviewBy: formatDate(a.reviewBy),
          url: `${this.webUrl}/dashboard/kb/articles/${a.id}`,
        })),
      }),
    );
    const subject: string = count === 1 ? "1 knowledge base article is due for review" : `${count} knowledge base articles are due for review`;
    await this.mail.send(recipient.email, subject, html, organizationId);
  }

  private async loadStaff(orgIds: string[]): Promise<Map<string, Array<StaffMember>>> {
    const rows = await this.prisma.member.findMany({
      where: { organizationId: { in: orgIds }, role: { in: ["owner", "admin"] } },
      select: { organizationId: true, userId: true, role: true, user: { select: { name: true, email: true } } },
    });
    const byOrg = new Map<string, StaffMember[]>();
    for (const r of rows) {
      const list = byOrg.get(r.organizationId) ?? [];
      list.push({ userId: r.userId, role: r.role, name: r.user.name, email: r.user.email });
      byOrg.set(r.organizationId, list);
    }
    return byOrg;
  }

  private async loadOrgNames(orgIds: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** The article owner while they are still staff; otherwise the workspace owners. */
  private recipients(staff: StaffMember[], ownerId: string | null): StaffMember[] {
    const owner: StaffMember | undefined = ownerId ? staff.find((m) => m.userId === ownerId) : undefined;
    if (owner) return [owner];
    return staff.filter((m) => m.role === "owner");
  }
}
