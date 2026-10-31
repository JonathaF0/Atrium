import "../common/testing/mock-email";
import { describe, expect, it, mock } from "bun:test";
import { AnnouncementNotificationsService, type NotifiableAnnouncement } from "./announcement-notifications.service";
import { fakeEmailRenderer } from "../common/testing/fake-email-renderer";
import type { PrismaService } from "../prisma/prisma.service";
import type { MailService } from "../mail/mail.service";
import type { InAppNotificationsService } from "../notifications/in-app-notifications.service";
import type { PushService } from "../notifications/push.service";
import type { IntegrationDispatcher } from "../integrations/integration-dispatcher.service";
import type { AudienceResolver } from "./audience-resolver.service";
import type { ConfigService } from "@nestjs/config";
import type { PinoLogger } from "nestjs-pino";

function announcement(over: Partial<NotifiableAnnouncement> = {}): NotifiableAnnouncement {
  return {
    id: "a1",
    organizationId: "org1",
    type: "maintenance",
    title: "Sample maintenance",
    body: "We will patch servers.",
    impact: "Short outages",
    windowStart: new Date("2026-11-02T22:00:00Z"),
    windowEnd: new Date("2026-11-02T23:00:00Z"),
    audienceType: "companies",
    audienceValue: null,
    audiences: [{ companyId: "A" }],
    emailOnPublish: false,
    pushOnPublish: false,
    ...over,
  };
}

function build(recipients: string[] = ["u1", "u2"]) {
  const inApp = { createMany: mock(async () => undefined) };
  const push = { sendToMany: mock(async () => undefined) };
  const mail = { send: mock(async () => ({ sent: true, viaOrgConfig: false })) };
  const integrations = { dispatch: mock(() => undefined) };
  const audience = { recipientUserIds: mock(async () => recipients) };
  const prisma = {
    organization: { findUnique: mock(async () => ({ name: "Sample IT" })) },
    user: {
      findMany: mock(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ email: `${id}@example.com`, name: id })),
      ),
    },
  };
  const logger = { warn: () => undefined, error: () => undefined } as unknown as PinoLogger;
  const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
  const service = new AnnouncementNotificationsService(
    prisma as unknown as PrismaService,
    config,
    mail as unknown as MailService,
    fakeEmailRenderer(),
    inApp as unknown as InAppNotificationsService,
    push as unknown as PushService,
    integrations as unknown as IntegrationDispatcher,
    audience as unknown as AudienceResolver,
    logger,
  );
  return { service, inApp, push, mail, integrations, audience };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("AnnouncementNotificationsService", () => {
  it("notifies resolved recipients in-app with a portal link, and nothing else when not opted in", async () => {
    const { service, inApp, push, mail, integrations } = build();
    expect(await service.published(announcement(), "owner1")).toBe(2);
    await flush();
    const rows = (inApp.createMany.mock.calls[0] as unknown as [{ userId: string; link: string; type: string }[]])[0];
    expect(rows.map((r) => r.userId)).toEqual(["u1", "u2"]);
    expect(rows[0].link).toBe("/portal/announcements?id=a1");
    expect(rows[0].type).toBe("announcement");
    expect(push.sendToMany).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect((integrations.dispatch.mock.calls[0] as unknown as [{ event: string }])[0].event).toBe("announcement.published");
  });

  it("sends email and push to the same recipients when opted in", async () => {
    const { service, push, mail } = build();
    await service.published(announcement({ emailOnPublish: true, pushOnPublish: true }), "owner1");
    await flush();
    expect((push.sendToMany.mock.calls[0] as unknown as [string[]])[0]).toEqual(["u1", "u2"]);
    const to = mail.send.mock.calls.map((c) => (c as unknown as [string])[0]).sort();
    expect(to).toEqual(["u1@example.com", "u2@example.com"]);
  });

  it("incident updates skip email and push when the update asks not to notify", async () => {
    const { service, push, mail, inApp, integrations } = build();
    await service.updated(
      announcement({ type: "incident", emailOnPublish: true, pushOnPublish: true }),
      { body: "Fixed", state: "resolved" },
      "owner1",
      false,
    );
    await flush();
    expect(inApp.createMany).toHaveBeenCalledTimes(1);
    expect(push.sendToMany).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect((integrations.dispatch.mock.calls[0] as unknown as [{ event: string }])[0].event).toBe("announcement.updated");
  });

  it("does nothing when the audience is empty", async () => {
    const { service, inApp } = build([]);
    expect(await service.maintenanceReminder(announcement({ emailOnPublish: true }))).toBe(0);
    expect(inApp.createMany).not.toHaveBeenCalled();
  });
});
