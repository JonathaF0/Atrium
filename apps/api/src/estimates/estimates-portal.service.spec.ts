import { beforeEach, describe, expect, it, mock } from "bun:test";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { AttachmentStorageService, AuditService, ClientScope, ClientScopeService } from "../service-core";
import type { EstimateNotificationsService } from "./estimate-notifications.service";
import { EstimatesPortalService, decodeSignaturePng } from "./estimates-portal.service";
import { serializeForClient } from "./estimate-serialize";

// 1x1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

function scope(over: Partial<ClientScope> = {}): ClientScope {
  return {
    userId: "client-1",
    organizationId: "org-1",
    contactId: "contact-1",
    companyId: "co-1",
    companyAdmin: false,
    email: "client@example.com",
    name: "Sample Client",
    ...over,
  };
}

function estimate(over: Record<string, unknown> = {}) {
  return {
    id: "est-1",
    organizationId: "org-1",
    number: "EST-1001",
    version: 1,
    rootId: "est-1",
    status: "sent",
    title: "Network refresh",
    introduction: null,
    companyId: "co-1",
    contactId: "contact-1",
    recipientUserId: "client-1",
    projectId: null,
    ticketId: null,
    currency: null,
    discountType: null,
    discountValue: null,
    depositPercent: null,
    assumptions: null,
    exclusions: null,
    terms: null,
    validUntil: new Date(Date.now() + 10 * 86_400_000),
    sentAt: new Date(),
    viewedAt: null,
    respondedAt: null,
    expiryReminderSentAt: null,
    acceptedById: null,
    acceptedName: null,
    signatureKey: null,
    declineReason: null,
    convertedAt: null,
    documentId: null,
    aiDrafted: true,
    createdById: "staff-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    lineItems: [
      {
        id: "li-1",
        estimateId: "est-1",
        catalogItemId: "cat-1",
        group: null,
        name: "Switch",
        description: null,
        unit: "each",
        billingType: "fixed",
        recurringInterval: null,
        quantity: 2,
        unitPriceCents: 50000,
        costCents: 30000,
        taxable: true,
        taxRateBps: 1000,
        optional: false,
        selected: true,
        order: 0,
      },
      {
        id: "li-2",
        estimateId: "est-1",
        catalogItemId: null,
        group: null,
        name: "Extended warranty",
        description: null,
        unit: "each",
        billingType: "fixed",
        recurringInterval: null,
        quantity: 1,
        unitPriceCents: 10000,
        costCents: 2000,
        taxable: false,
        taxRateBps: 0,
        optional: true,
        selected: false,
        order: 1,
      },
    ],
    ...over,
  };
}

function setup(current: Record<string, unknown> | null = estimate(), clientScope: ClientScope = scope()) {
  const prisma = {
    estimate: {
      findFirst: mock((): Promise<unknown> => Promise.resolve(current)),
      findMany: mock(() => Promise.resolve([])),
      count: mock(() => Promise.resolve(0)),
      updateMany: mock(() => Promise.resolve({ count: 1 })),
    },
    estimateEvent: { create: mock(() => Promise.resolve({})) },
    estimateComment: {
      findMany: mock(() => Promise.resolve([])),
      create: mock(() => Promise.resolve({})),
    },
    estimateLineItem: { update: mock(() => Promise.resolve({})) },
    user: {
      findMany: mock(() => Promise.resolve([])),
      findUnique: mock(() => Promise.resolve({ name: "Sample Client" })),
    },
    $transaction: mock((arg: unknown): Promise<unknown> =>
      typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as unknown[]),
    ),
  };
  const scopes = { resolve: mock(() => Promise.resolve(clientScope)) };
  const storage = {
    storeBuffer: mock(() => Promise.resolve("org-1/estimate-signatures/key.png")),
    remove: mock(() => Promise.resolve()),
  };
  const audit = { record: mock(() => Promise.resolve()) };
  const notifications = {
    notifyClientAction: mock(() => undefined),
    notifyClientComment: mock(() => undefined),
  };
  const service = new EstimatesPortalService(
    prisma as unknown as PrismaService,
    scopes as unknown as ClientScopeService,
    storage as unknown as AttachmentStorageService,
    audit as unknown as AuditService,
    notifications as unknown as EstimateNotificationsService,
  );
  return { prisma, scopes, storage, audit, notifications, service };
}

const ctx = { userId: "client-1", orgId: "org-1", preview: false, req: { ip: "203.0.113.5", headers: { "user-agent": "test-agent" } } };

describe("EstimatesPortalService scoping", () => {
  it("lists only visible statuses for the recipient", async () => {
    const { prisma, service } = setup();
    await service.listMine("client-1", "org-1", { page: 1, limit: 20 });
    const where = (prisma.estimate.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where.organizationId).toBe("org-1");
    expect((where.status as { in: string[] }).in).not.toContain("draft");
    expect((where.status as { in: string[] }).in).not.toContain("superseded");
    expect(where.AND).toEqual([{ OR: [{ recipientUserId: "client-1" }] }]);
  });

  it("lets a company admin see the company's estimates", async () => {
    const { prisma, service } = setup(estimate(), scope({ companyAdmin: true }));
    await service.listMine("client-1", "org-1", { page: 1, limit: 20 });
    const where = (prisma.estimate.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where.AND).toEqual([{ OR: [{ recipientUserId: "client-1" }, { companyId: "co-1" }] }]);
  });

  it("returns 404 for an estimate outside the client's scope", async () => {
    const { service } = setup(null);
    await expect(service.getMine(ctx, "est-1")).rejects.toThrow(NotFoundException);
  });
});

describe("client view", () => {
  it("never exposes cost, margin, catalog ids or the signature key", () => {
    const view = serializeForClient(estimate({ signatureKey: "secret" }) as never) as Record<string, unknown>;
    const json = JSON.stringify(view);
    expect(json).not.toContain("costCents");
    expect(json).not.toContain("margin");
    expect(json).not.toContain("catalogItemId");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("aiDrafted");
  });

  it("marks the estimate viewed once, with IP and user agent", async () => {
    const { prisma, service } = setup();
    const view = await service.getMine(ctx, "est-1");
    expect(view.status).toBe("viewed");
    expect(prisma.estimate.updateMany).toHaveBeenCalledTimes(1);
    const event = (prisma.estimateEvent.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(event).toMatchObject({ action: "viewed", ipAddress: "203.0.113.5", userAgent: "test-agent" });
  });

  it("does not record a view when the guarded update loses the race", async () => {
    const { prisma, service } = setup();
    prisma.estimate.updateMany.mockImplementationOnce(() => Promise.resolve({ count: 0 }));
    await service.getMine(ctx, "est-1");
    expect(prisma.estimateEvent.create).not.toHaveBeenCalled();
  });

  it("does not mark viewed during a staff preview", async () => {
    const { prisma, service } = setup();
    await service.getMine({ ...ctx, preview: true }, "est-1");
    expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
  });
});

describe("client responses", () => {
  it("toggles an optional item and records the event", async () => {
    const { prisma, service } = setup();
    await service.toggleOption(ctx, "est-1", { lineItemId: "li-2", selected: true });
    expect(prisma.estimateLineItem.update).toHaveBeenCalledWith({ where: { id: "li-2" }, data: { selected: true } });
  });

  it("refuses to toggle a required item", async () => {
    const { service } = setup();
    await expect(service.toggleOption(ctx, "est-1", { lineItemId: "li-1", selected: false })).rejects.toThrow(BadRequestException);
  });

  it("refuses responses once the estimate is settled", async () => {
    const { service } = setup(estimate({ status: "accepted" }));
    await expect(service.decline(ctx, "est-1", { reason: "x" })).rejects.toThrow(BadRequestException);
  });

  it("refuses to accept an expired estimate", async () => {
    const { service, storage } = setup(estimate({ validUntil: new Date(Date.now() - 1000) }));
    await expect(
      service.accept(ctx, "est-1", { fullName: "Sample Client", signature: PNG_DATA_URL, agree: true }),
    ).rejects.toThrow(/expired/);
    expect(storage.storeBuffer).not.toHaveBeenCalled();
  });

  it("accepts with a typed name and drawn signature, then audits and notifies", async () => {
    const { prisma, service, storage, audit, notifications } = setup();
    await service.accept(ctx, "est-1", { fullName: "  Sample   Client ", signature: PNG_DATA_URL, agree: true });
    expect(storage.storeBuffer).toHaveBeenCalledTimes(1);
    const update = (prisma.estimate.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown>; where: Record<string, unknown> }])[0];
    expect(update.data).toMatchObject({
      status: "accepted",
      acceptedById: "client-1",
      acceptedName: "Sample Client",
      signatureKey: "org-1/estimate-signatures/key.png",
    });
    expect(update.where).toMatchObject({ id: "est-1", organizationId: "org-1" });
    expect((audit.record.mock.calls[0] as unknown as [{ action: string }])[0].action).toBe("estimate.accepted");
    expect(notifications.notifyClientAction).toHaveBeenCalled();
  });

  it("removes the stored signature when someone else answered first", async () => {
    const { prisma, service, storage } = setup();
    prisma.estimate.updateMany.mockImplementation(() => Promise.resolve({ count: 0 }));
    await expect(
      service.accept({ ...ctx, preview: true }, "est-1", { fullName: "Sample Client", signature: PNG_DATA_URL, agree: true }),
    ).rejects.toThrow(ConflictException);
    expect(storage.remove).toHaveBeenCalledWith("org-1/estimate-signatures/key.png");
  });

  it("requires the agreement box", async () => {
    const { service } = setup();
    await expect(service.accept(ctx, "est-1", { fullName: "A B", signature: PNG_DATA_URL, agree: false })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("request changes stores the comment and notifies staff", async () => {
    const { prisma, service, notifications } = setup();
    await service.requestChanges(ctx, "est-1", { content: "Please add a second site" });
    expect(prisma.estimateComment.create).toHaveBeenCalled();
    const update = (prisma.estimate.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(update.data.status).toBe("changes_requested");
    expect(notifications.notifyClientAction.mock.calls[0]).toContain("changes_requested");
  });
});

describe("decodeSignaturePng", () => {
  it("accepts a PNG data URL", () => {
    expect(decodeSignaturePng(PNG_DATA_URL).subarray(1, 4).toString()).toBe("PNG");
  });
  it("rejects other image types and junk", () => {
    expect(() => decodeSignaturePng("data:image/svg+xml;base64,PHN2Zz4=")).toThrow(BadRequestException);
    expect(() => decodeSignaturePng(`data:image/png;base64,${Buffer.from("x".repeat(200)).toString("base64")}`)).toThrow(
      BadRequestException,
    );
    expect(() => decodeSignaturePng("data:image/png;base64,AAAA")).toThrow(BadRequestException);
  });
  it("rejects an oversized image", () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600 * 1024)]);
    expect(() => decodeSignaturePng(`data:image/png;base64,${big.toString("base64")}`)).toThrow(BadRequestException);
  });
});
