import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { Ticket } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { SettingsService } from "../settings/settings.service";
import { HelpdeskNotificationsService } from "./helpdesk-notifications.service";
import { SlaService, type LoadedPolicy } from "./sla.service";
import { warnAt } from "./sla";
import { statusSideEffects } from "./ticket-status";
import { InboundEmailService } from "./inbound/inbound.service";
import { fetchNewMessages } from "./inbound/imap-client";

const BATCH = 200;
const WARN_LOOKAHEAD_MS = 14 * 24 * 3_600_000;
const RUNNING_STATUSES = ["new", "open"];
const DAY_MS = 24 * 3_600_000;

/**
 * Every claim below is a conditional updateMany (`... where flag is still
 * unset`), so when several API instances run the same cron only one of them
 * acts on a given ticket.
 */
@Injectable()
export class SlaTask {
  private readonly logger = new Logger(SlaTask.name);
  private running = false;

  constructor(
    private prisma: PrismaService,
    private sla: SlaService,
    private notifications: HelpdeskNotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      await this.breaches(now);
      await this.warnings(now);
    } catch (err) {
      this.logger.error("SLA check failed", err);
    } finally {
      this.running = false;
    }
  }

  async breaches(now: Date): Promise<number> {
    let count = 0;
    const firstResponse = await this.prisma.ticket.findMany({
      where: { status: { in: RUNNING_STATUSES }, slaPausedAt: null, firstRespondedAt: null, firstResponseBreached: false, firstResponseDueAt: { lte: now } },
      take: BATCH,
    });
    for (const t of firstResponse) {
      const { count: claimed } = await this.prisma.ticket.updateMany({
        where: { id: t.id, firstResponseBreached: false, firstRespondedAt: null },
        data: { firstResponseBreached: true, slaEscalatedAt: now },
      });
      if (claimed === 1) {
        await this.recordBreach(t, "first_response");
        count++;
      }
    }
    const resolution = await this.prisma.ticket.findMany({
      where: { status: { in: RUNNING_STATUSES }, slaPausedAt: null, resolutionBreached: false, resolutionDueAt: { lte: now } },
      take: BATCH,
    });
    for (const t of resolution) {
      const { count: claimed } = await this.prisma.ticket.updateMany({
        where: { id: t.id, resolutionBreached: false },
        data: { resolutionBreached: true, slaEscalatedAt: now },
      });
      if (claimed === 1) {
        await this.recordBreach(t, "resolution");
        count++;
      }
    }
    return count;
  }

  private async recordBreach(ticket: Ticket, kind: "first_response" | "resolution"): Promise<void> {
    await this.prisma.ticketEvent.create({ data: { ticketId: ticket.id, type: "sla_breach", toValue: kind } });
    const policy = ticket.slaPolicyId
      ? await this.prisma.slaPolicy.findUnique({ where: { id: ticket.slaPolicyId }, select: { escalateToId: true } })
      : null;
    this.notifications.slaBreached(ticket.id, kind, policy?.escalateToId ?? null);
  }

  async warnings(now: Date): Promise<number> {
    const horizon = new Date(now.getTime() + WARN_LOOKAHEAD_MS);
    const candidates = await this.prisma.ticket.findMany({
      where: {
        status: { in: RUNNING_STATUSES },
        slaPausedAt: null,
        slaWarnedAt: null,
        slaPolicyId: { not: null },
        OR: [
          { firstRespondedAt: null, firstResponseBreached: false, firstResponseDueAt: { lte: horizon } },
          { resolutionBreached: false, resolutionDueAt: { lte: horizon } },
        ],
      },
      orderBy: { resolutionDueAt: "asc" },
      take: BATCH,
    });
    const policies = new Map<string, LoadedPolicy | null>();
    let warned = 0;
    for (const t of candidates) {
      const policyId = t.slaPolicyId as string;
      if (!policies.has(policyId)) policies.set(policyId, await this.sla.load(policyId, t.organizationId));
      const policy = policies.get(policyId);
      if (!policy) continue;
      const target = policy.targets[t.priority as keyof typeof policy.targets] ?? policy.targets.normal;
      const kind: "first_response" | "resolution" = !t.firstRespondedAt && !t.firstResponseBreached ? "first_response" : "resolution";
      const mins: number = kind === "first_response" ? target.firstResponseMins : target.resolutionMins;
      const at: Date | null = warnAt(t.createdAt, mins, policy.warnAtPercent, t.slaPausedSeconds, policy.calendar);
      if (!at || at > now) continue;
      const { count } = await this.prisma.ticket.updateMany({ where: { id: t.id, slaWarnedAt: null }, data: { slaWarnedAt: now } });
      if (count === 1) {
        await this.prisma.ticketEvent.create({ data: { ticketId: t.id, type: "sla_warning", toValue: kind } });
        this.notifications.slaWarning(t.id, kind);
        warned++;
      }
    }
    return warned;
  }
}

@Injectable()
export class AutoCloseTask {
  private readonly logger = new Logger(AutoCloseTask.name);

  constructor(
    private prisma: PrismaService,
    private notifications: HelpdeskNotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async run(): Promise<void> {
    try {
      await this.closeDue(new Date());
    } catch (err) {
      this.logger.error("Ticket auto-close failed", err);
    }
  }

  async closeDue(now: Date): Promise<number> {
    const settings = await this.prisma.serviceSettings.findMany({
      where: { OR: [{ closeResolvedAfterDays: { gt: 0 } }, { closeWaitingAfterDays: { gt: 0 } }] },
      select: { organizationId: true, closeResolvedAfterDays: true, closeWaitingAfterDays: true },
    });
    let closed = 0;
    for (const s of settings) {
      if (s.closeResolvedAfterDays > 0) {
        const due = await this.prisma.ticket.findMany({
          where: { organizationId: s.organizationId, status: "resolved", resolvedAt: { lte: new Date(now.getTime() - s.closeResolvedAfterDays * DAY_MS) } },
          take: BATCH,
        });
        for (const t of due) {
          if (await this.close(t, now, `Closed automatically ${s.closeResolvedAfterDays} day(s) after it was resolved.`, false)) closed++;
        }
      }
      if (s.closeWaitingAfterDays > 0) {
        const due = await this.prisma.ticket.findMany({
          where: { organizationId: s.organizationId, status: "waiting_client", waitingSince: { lte: new Date(now.getTime() - s.closeWaitingAfterDays * DAY_MS) } },
          take: BATCH,
        });
        for (const t of due) {
          if (await this.close(t, now, `Closed automatically after ${s.closeWaitingAfterDays} day(s) without a reply. Reply to reopen the conversation as a new request.`, true)) closed++;
        }
      }
    }
    return closed;
  }

  /** Claims by status: a ticket someone touched since it was read is left alone. */
  private async close(ticket: Ticket, now: Date, message: string, notify: boolean): Promise<boolean> {
    const { status: _status, ...rest } = statusSideEffects(ticket, "closed", now);
    void _status;
    const { count } = await this.prisma.ticket.updateMany({
      where: { id: ticket.id, status: ticket.status, updatedAt: ticket.updatedAt },
      data: { status: "closed", ...rest, lastActivityAt: now },
    });
    if (count !== 1) return false;
    await this.prisma.$transaction([
      this.prisma.ticketEvent.create({ data: { ticketId: ticket.id, type: "status", fromValue: ticket.status, toValue: "closed", detail: "auto-close" } }),
      this.prisma.ticketMessage.create({
        data: { ticketId: ticket.id, organizationId: ticket.organizationId, visibility: "public", source: "system", authorName: "System", body: message },
      }),
    ]);
    this.notifications.statusChanged(ticket.id, ticket.status, "closed", { notifyRequester: notify, note: message });
    return true;
  }
}

@Injectable()
export class ImapPollTask {
  private readonly logger = new Logger(ImapPollTask.name);
  private running = false;

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private inbound: InboundEmailService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pollAll(new Date());
    } catch (err) {
      this.logger.error("IMAP poll failed", err);
    } finally {
      this.running = false;
    }
  }

  async pollAll(now: Date): Promise<void> {
    const configured = await this.prisma.serviceSettings.findMany({
      where: { inboundMode: "imap", imapHost: { not: null }, imapUser: { not: null }, imapPass: { not: null } },
      select: { organizationId: true },
    });
    for (const { organizationId } of configured) {
      // Claim this mailbox for this minute; another instance that loses the race skips it.
      const { count } = await this.prisma.serviceSettings.updateMany({
        where: { organizationId, OR: [{ imapLastPolledAt: null }, { imapLastPolledAt: { lt: new Date(now.getTime() - 50_000) } }] },
        data: { imapLastPolledAt: now },
      });
      if (count !== 1) continue;
      await this.pollOne(organizationId);
    }
  }

  private async pollOne(organizationId: string): Promise<void> {
    const s = await this.prisma.serviceSettings.findUnique({ where: { organizationId } });
    if (!s?.imapHost || !s.imapUser || !s.imapPass) return;
    try {
      const highest: number = await fetchNewMessages(
        {
          host: s.imapHost,
          port: s.imapPort ?? (s.imapSecure ? 993 : 143),
          secure: s.imapSecure,
          user: s.imapUser,
          pass: this.settings.decrypt(s.imapPass),
          mailbox: s.imapMailbox,
        },
        s.imapLastUid,
        async (uid: number, source: Buffer) => {
          try {
            await this.inbound.process(organizationId, await this.inbound.fromRaw(source));
          } catch (err) {
            this.logger.warn(`Skipping unreadable message ${uid} for ${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
          }
          await this.prisma.serviceSettings.update({ where: { organizationId }, data: { imapLastUid: uid } });
        },
      );
      await this.prisma.serviceSettings.update({ where: { organizationId }, data: { imapLastUid: highest, imapLastError: null } });
    } catch (err) {
      const message: string = err instanceof Error ? err.message.slice(0, 500) : "IMAP error";
      await this.prisma.serviceSettings.update({ where: { organizationId }, data: { imapLastError: message } });
      this.logger.warn(`IMAP poll for ${organizationId} failed: ${message}`);
    }
  }
}
