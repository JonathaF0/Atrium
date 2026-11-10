import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { assertDisposableDatabase } from "./guard";
import { PrismaService } from "../../src/prisma/prisma.service";
import { AuditLogService } from "../../src/audit-log/audit-log.service";

let prisma: PrismaService;
let service: AuditLogService;

const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const orgA = `audit-a-${s}`;
const orgB = `audit-b-${s}`;

beforeAll(async () => {
  assertDisposableDatabase();
  const mod = await Test.createTestingModule({
    providers: [PrismaService, AuditLogService, { provide: ConfigService, useValue: new ConfigService({}) }],
  }).compile();
  prisma = mod.get(PrismaService);
  service = mod.get(AuditLogService);
  await prisma.organization.createMany({ data: [{ id: orgA, name: "Audit A" }, { id: orgB, name: "Audit B" }] });
  await prisma.auditLog.createMany({
    data: [
      { organizationId: orgA, action: "ticket.merged", targetType: "ticket" },
      { organizationId: orgA, action: "ticket.deleted", targetType: "ticket" },
      { organizationId: orgA, action: "kb.article_published", targetType: "kb_article" },
      { organizationId: orgA, action: "export.contacts", targetType: "export" },
      { organizationId: orgB, action: "estimate.sent", targetType: "estimate" },
    ],
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await prisma.$disconnect();
});

describe("AuditLogService.facets", () => {
  it("lists the action groups and target types present in the workspace only", async () => {
    expect(await service.facets(orgA)).toEqual({
      actionGroups: ["export", "kb", "ticket"],
      targetTypes: ["export", "kb_article", "ticket"],
    });
  });

  it("filters by an action group prefix", async () => {
    const res = (await service.list(orgA, { action: "ticket." })) as { data: { action: string }[] };
    expect(res.data.map((r) => r.action).sort()).toEqual(["ticket.deleted", "ticket.merged"]);
  });
});
