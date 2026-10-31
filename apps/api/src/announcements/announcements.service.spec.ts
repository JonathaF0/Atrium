import { describe, expect, it, mock } from "bun:test";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { AnnouncementsService } from "./announcements.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService, ServiceSettingsService } from "../service-core";
import type { AudienceResolver } from "./audience-resolver.service";
import type { AnnouncementNotificationsService } from "./announcement-notifications.service";

const ORG = "org1";
const ACTOR = { id: "owner1", email: "owner@example.com" };

function existing(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    organizationId: ORG,
    type: "maintenance",
    severity: "info",
    status: "draft",
    incidentState: null,
    title: "Sample maintenance",
    body: "Body",
    impact: null,
    windowStart: null,
    windowEnd: null,
    publishAt: null,
    publishedAt: null,
    expiresAt: null,
    resolvedAt: null,
    postmortem: null,
    audienceType: "all",
    audienceValue: null,
    publicStatus: false,
    emailOnPublish: false,
    pushOnPublish: false,
    audiences: [],
    updates: [],
    _count: { tickets: 0 },
    ...over,
  };
}

function build(row: ReturnType<typeof existing> = existing(), companiesInOrg = ["A", "B"]) {
  const state = { row: { ...row } };
  const audit = { record: mock(async () => undefined) };
  const notifier = { published: mock(async () => 0), updated: mock(async () => 0) };
  const prisma = {
    announcement: {
      findFirst: mock(async () => ({ ...state.row })),
      create: mock(async ({ data }: { data: Record<string, unknown> }) => {
        state.row = { ...state.row, ...data, id: "a1" } as typeof state.row;
        return state.row;
      }),
      updateMany: mock(async ({ where, data }: { where: { status: string }; data: Record<string, unknown> }) => {
        if (state.row.status !== where.status) return { count: 0 };
        state.row = { ...state.row, ...data } as typeof state.row;
        return { count: 1 };
      }),
    },
    company: {
      count: mock(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => companiesInOrg.includes(id)).length,
      ),
    },
    announcementTemplate: { findFirst: mock(async () => null) },
  };
  const service = new AnnouncementsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    {} as ServiceSettingsService,
    {} as AudienceResolver,
    notifier as unknown as AnnouncementNotificationsService,
  );
  return { service, prisma, audit, notifier, state };
}

describe("AnnouncementsService validation", () => {
  it("refuses publicStatus for a targeted audience", async () => {
    const { service } = build();
    await expect(
      service.create(ORG, ACTOR, {
        type: "incident",
        title: "Outage",
        audienceType: "companies",
        companyIds: ["A"],
        publicStatus: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses company ids from another workspace", async () => {
    const { service, prisma } = build();
    await expect(
      service.create(ORG, ACTOR, { type: "general", title: "Hi", audienceType: "companies", companyIds: ["A", "foreign"] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.announcement.create).not.toHaveBeenCalled();
  });

  it("requires a value for contract and asset audiences", async () => {
    const { service } = build();
    await expect(service.create(ORG, ACTOR, { type: "general", title: "Hi", audienceType: "contracts" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.create(ORG, ACTOR, { type: "general", title: "Hi", audienceType: "assets", audienceValue: "  " }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a maintenance window that ends before it starts", async () => {
    const { service } = build();
    await expect(
      service.create(ORG, ACTOR, {
        type: "maintenance",
        title: "Patch",
        windowStart: "2026-11-02T10:00:00Z",
        windowEnd: "2026-11-02T09:00:00Z",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("starts incidents as investigating and audits creation", async () => {
    const { service, prisma, audit } = build();
    await service.create(ORG, ACTOR, { type: "incident", title: "Outage", body: "Looking" });
    const data = (prisma.announcement.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.incidentState).toBe("investigating");
    expect(data.organizationId).toBe(ORG);
    expect(data.createdById).toBe("owner1");
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});

describe("AnnouncementsService lifecycle", () => {
  it("publishes a draft once, audits it and notifies", async () => {
    const { service, audit, notifier, state } = build();
    await service.publish(ORG, "a1", ACTOR);
    expect(state.row.status).toBe("published");
    expect(state.row.publishedAt).toBeInstanceOf(Date);
    expect(notifier.published).toHaveBeenCalledTimes(1);
    expect((audit.record.mock.calls[0] as unknown as [{ action: string }])[0].action).toBe("announcement.published");
    await expect(service.publish(ORG, "a1", ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    expect(notifier.published).toHaveBeenCalledTimes(1);
  });

  it("reports a conflict when the status changed underneath", async () => {
    const { service, prisma } = build();
    prisma.announcement.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    await expect(service.publish(ORG, "a1", ACTOR)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses to publish with an expiry in the past", async () => {
    const { service } = build(existing({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(service.publish(ORG, "a1", ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses to schedule in the past", async () => {
    const { service } = build();
    await expect(service.schedule(ORG, "a1", ACTOR, new Date(Date.now() - 60_000))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("only expires published announcements", async () => {
    const { service } = build();
    await expect(service.expire(ORG, "a1", ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });
});
