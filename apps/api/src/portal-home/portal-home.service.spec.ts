import { describe, expect, it, mock } from "bun:test";
import { PortalHomeService } from "./portal-home.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ClientScope, ClientScopeService } from "../service-core";
import type { AudienceResolver } from "../announcements/audience-resolver.service";
import type { AnnouncementsPortalService } from "../announcements/announcements-portal.service";
import type { ConfigService } from "@nestjs/config";
import type { PinoLogger } from "nestjs-pino";

const NOW = new Date("2026-10-31T12:00:00Z");

function scope(over: Partial<ClientScope> = {}): ClientScope {
  return {
    userId: "u1",
    organizationId: "org1",
    contactId: "c1",
    companyId: "A",
    companyAdmin: false,
    email: null,
    name: null,
    ...over,
  };
}

function build(s: ClientScope = scope(), overrides: Record<string, unknown> = {}) {
  const prisma = {
    project: { findMany: mock(async () => [{ id: "p1" }]) },
    company: { findFirst: mock(async () => ({ name: "Sample Company" })) },
    ticket: {
      count: mock(async () => 2),
      findMany: mock(async () => [
        { id: "t1", number: 1001, subject: "Printer", status: "open", priority: "normal", lastActivityAt: NOW },
      ]),
    },
    serviceSettings: { findUnique: mock(async () => ({ ticketPrefix: "TKT" })) },
    invoice: {
      findMany: mock(async () => [
        { id: "i1", invoiceNumber: "INV-1", status: "sent", dueDate: null, type: "itemized", amount: null, projectId: "p1", project: { name: "P" }, lineItems: [{ quantity: 2, unitPrice: 500 }] },
        { id: "i2", invoiceNumber: "INV-2", status: "overdue", dueDate: null, type: "uploaded", amount: 3000, projectId: "p1", project: { name: "P" }, lineItems: [] },
      ]),
    },
    asset: { findMany: mock(async () => []) },
    contract: { findMany: mock(async () => []) },
    projectUpdate: { findMany: mock(async () => []) },
    ...overrides,
  };
  const clientScope = { resolve: mock(async () => s) };
  const audience = { viewer: mock(async () => ({ userId: "u1", organizationId: "org1", privileged: false, facts: {} })) };
  const announcements = { unreadCount: mock(async () => 1), banner: mock(async () => []) };
  const logger = { warn: mock(() => undefined) };
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new PortalHomeService(
    prisma as unknown as PrismaService,
    config,
    clientScope as unknown as ClientScopeService,
    audience as unknown as AudienceResolver,
    announcements as unknown as AnnouncementsPortalService,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, logger };
}

describe("PortalHomeService", () => {
  it("scopes tickets to the requester (and company for admins) and formats references", async () => {
    const { service, prisma } = build();
    const home = await service.get("u1", "org1", "member", NOW);
    expect(home.tickets).toEqual({
      openCount: 2,
      latest: [{ id: "t1", reference: "TKT-1001", subject: "Printer", status: "open", priority: "normal", lastActivityAt: NOW }],
    });
    const where = (prisma.ticket.count.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where.OR).toEqual([{ requesterUserId: "u1" }]);
    expect(where.organizationId).toBe("org1");

    const admin = build(scope({ companyAdmin: true }));
    await admin.service.get("u1", "org1", "member", NOW);
    const adminWhere = (admin.prisma.ticket.count.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(adminWhere.OR).toEqual([{ requesterUserId: "u1" }, { companyId: "A" }]);
  });

  it("lists only sent/overdue invoices of assigned projects, never drafts", async () => {
    const { service, prisma } = build();
    const home = await service.get("u1", "org1", "member", NOW);
    const args = (prisma.invoice.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(args.projectId).toEqual({ in: ["p1"] });
    expect(args.AND).toEqual([{ status: { notIn: ["draft", "cancelled"] } }, { status: { in: ["sent", "overdue"] } }]);
    const projectWhere = (prisma.project.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(projectWhere.clients).toEqual({ some: { userId: "u1" } });
    expect(home.invoices?.outstandingCount).toBe(2);
    expect(home.invoices?.overdueCount).toBe(1);
    expect(home.invoices?.outstandingCents).toBe(4000);
    expect(home.invoices?.latest[0].status).toBe("overdue");
    expect(home.quickActions).toEqual({ requestProjectId: "p1", payInvoiceProjectId: "p1" });
  });

  it("skips invoice and update queries when the client has no projects", async () => {
    const { service, prisma } = build(scope(), { project: { findMany: mock(async () => []) } });
    const home = await service.get("u1", "org1", "member", NOW);
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(home.invoices?.latest).toEqual([]);
    expect(home.updates?.latest).toEqual([]);
    expect(home.quickActions.requestProjectId).toBeNull();
  });

  it("shows contracts to company admins only, and nothing for users without a company", async () => {
    const member = build();
    expect((await member.service.get("u1", "org1", "member", NOW)).renewals?.contracts).toBeNull();
    expect(member.prisma.contract.findMany).not.toHaveBeenCalled();

    const admin = build(scope({ companyAdmin: true }));
    expect((await admin.service.get("u1", "org1", "member", NOW)).renewals?.contracts).toEqual([]);
    const contractWhere = (admin.prisma.contract.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(contractWhere.companyId).toBe("A");
    expect(contractWhere.status).toBe("active");

    const none = build(scope({ companyId: null }));
    const home = await none.service.get("u1", "org1", "member", NOW);
    expect(home.renewals).toEqual({ assets: [], contracts: null });
    expect(home.company).toBeNull();
    expect(none.prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("only offers client-visible active assets of the viewer's company", async () => {
    const { service, prisma } = build();
    await service.get("u1", "org1", "member", NOW);
    const where = (prisma.asset.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ organizationId: "org1", companyId: "A", clientVisible: true, status: "active" });
  });

  it("a failing section is null and the rest still load", async () => {
    const { service, logger } = build(scope(), {
      ticket: { count: mock(async () => Promise.reject(new Error("no table"))), findMany: mock(async () => []) },
    });
    const home = await service.get("u1", "org1", "member", NOW);
    expect(home.tickets).toBeNull();
    expect(home.invoices).not.toBeNull();
    expect(home.announcements).toEqual({ unread: 1, banner: [] });
    expect(logger.warn).toHaveBeenCalled();
  });
});
