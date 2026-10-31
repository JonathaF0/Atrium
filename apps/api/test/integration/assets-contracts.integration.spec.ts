import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Test } from "@nestjs/testing";
import { assertDisposableDatabase } from "./guard";
import { PrismaService } from "../../src/prisma/prisma.service";
import { AuditService, ClientScopeService } from "../../src/service-core";
import { AssetSyncService } from "../../src/assets/asset-sync.service";
import { AssetsService } from "../../src/assets/assets.service";
import { ContractsService } from "../../src/contracts/contracts.service";
import type { SyncAssetInput } from "../../src/assets/asset-sync";

let prisma: PrismaService;
let sync: AssetSyncService;
let assets: AssetsService;
let contracts: ContractsService;
const orgIds: string[] = [];
let orgA: string;
let orgB: string;
let companyA: string;
let companyB: string;
let userId: string;
let projectId: string;
const actor = { id: null };

beforeAll(async () => {
  assertDisposableDatabase();
  const mod = await Test.createTestingModule({ providers: [PrismaService] }).compile();
  prisma = mod.get(PrismaService);
  const audit = new AuditService(prisma, { error: () => undefined } as never);
  const scope = new ClientScopeService(prisma);
  sync = new AssetSyncService(prisma, audit);
  assets = new AssetsService(prisma, audit, scope);
  contracts = new ContractsService(prisma, audit, scope);
});

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgA = (await prisma.organization.create({ data: { id: `ac-a-${stamp}`, name: `A ${stamp}`, slug: `ac-a-${stamp}` } })).id;
  orgB = (await prisma.organization.create({ data: { id: `ac-b-${stamp}`, name: `B ${stamp}`, slug: `ac-b-${stamp}` } })).id;
  orgIds.push(orgA, orgB);
  companyA = (await prisma.company.create({ data: { organizationId: orgA, name: "Sample Company" } })).id;
  companyB = (await prisma.company.create({ data: { organizationId: orgB, name: "Sample Company" } })).id;
  userId = (await prisma.user.create({ data: { id: `ac-u-${stamp}`, name: "Staff", email: `staff-${stamp}@example.com`, emailVerified: true } })).id;
  projectId = (await prisma.project.create({ data: { organizationId: orgA, name: "Support" } })).id;
});

afterAll(async () => {
  if (prisma) {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: "ac-u-" } } });
    await prisma.$disconnect();
  }
});

function batch(n: number, over: Partial<SyncAssetInput> = {}): SyncAssetInput[] {
  return Array.from({ length: n }, (_, i) => ({
    externalId: `dev-${i}`,
    companyName: "sample company",
    type: "device" as const,
    name: `Workstation ${i}`,
    serialNumber: `SN-${i}`,
    warrantyEndsAt: "2027-06-30",
    metadata: { os: "Linux", cores: 4 },
    ...over,
  }));
}

describe("asset sync", () => {
  it("is idempotent: the same batch twice creates once, then only updates", async () => {
    const first = await sync.sync(orgA, "sample-rmm", batch(3), false, actor);
    expect(first).toMatchObject({ created: 3, updated: 0, retired: 0, errors: [] });
    const second = await sync.sync(orgA, "sample-rmm", batch(3), false, actor);
    expect(second).toMatchObject({ created: 0, updated: 3 });
    const rows = await prisma.asset.findMany({ where: { organizationId: orgA }, orderBy: { externalId: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ companyId: companyA, externalSource: "sample-rmm", status: "active" });
    expect(rows[0].metadata).toEqual({ os: "Linux", cores: 4 });
  });

  it("keeps workspaces and sources apart", async () => {
    await sync.sync(orgA, "sample-rmm", batch(2), false, actor);
    await sync.sync(orgB, "sample-rmm", batch(2), false, actor);
    await sync.sync(orgA, "other-psa", batch(1), false, actor);
    expect(await prisma.asset.count({ where: { organizationId: orgA } })).toBe(3);
    expect(await prisma.asset.count({ where: { organizationId: orgB, companyId: companyB } })).toBe(2);

    // A company id from another workspace is rejected, not written.
    const res = await sync.sync(orgA, "sample-rmm", batch(1, { externalId: "x", companyName: undefined, companyId: companyB }), false, actor);
    expect(res.errors).toEqual([{ index: 0, externalId: "x", reason: "Unknown company" }]);
    expect(await prisma.asset.count({ where: { companyId: companyB, organizationId: orgA } })).toBe(0);
  });

  it("full sync retires only this source's missing records and a later batch reactivates them", async () => {
    await sync.sync(orgA, "sample-rmm", batch(3), false, actor);
    await sync.sync(orgA, "other-psa", batch(1), false, actor);
    await sync.sync(orgB, "sample-rmm", batch(3), false, actor);
    const res = await sync.sync(orgA, "sample-rmm", batch(1), true, actor);
    expect(res.retired).toBe(2);
    expect(await prisma.asset.count({ where: { organizationId: orgA, status: "retired" } })).toBe(2);
    expect(await prisma.asset.count({ where: { organizationId: orgA, externalSource: "other-psa", status: "active" } })).toBe(1);
    expect(await prisma.asset.count({ where: { organizationId: orgB, status: "retired" } })).toBe(0);

    await sync.sync(orgA, "sample-rmm", batch(3), false, actor);
    expect(await prisma.asset.count({ where: { organizationId: orgA, status: "retired" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA, action: "asset.synced" } })).toBe(4);
  });

  it("portal listing only shows the client's company's visible assets", async () => {
    await sync.sync(orgA, "sample-rmm", batch(2), false, actor);
    await prisma.asset.updateMany({ where: { organizationId: orgA, externalId: "dev-1" }, data: { clientVisible: false } });
    const client = await prisma.user.create({
      data: { id: `ac-u-client-${Date.now()}`, name: "Client", email: `client-${Date.now()}@example.com`, emailVerified: true },
    });
    await prisma.contact.create({ data: { organizationId: orgA, name: "Client", userId: client.id, companyId: companyA } });
    const mine = await assets.mine(client.id, orgA);
    expect(mine.map((a) => a.name)).toEqual(["Workstation 0"]);
    expect(await assets.mine(client.id, orgB)).toEqual([]);
  });
});

describe("contract usage", () => {
  async function entry(startedAt: string, minutes: number, contractId: string | null, organizationId = orgA, project = projectId) {
    const start = new Date(startedAt);
    return prisma.timeEntry.create({
      data: {
        organizationId,
        projectId: project,
        userId,
        startedAt: start,
        endedAt: new Date(start.getTime() + minutes * 60_000),
        durationSec: minutes * 60,
        billable: false,
        contractId,
      },
    });
  }

  it("sums only this contract's entries inside the current period", async () => {
    const c = await contracts.create(
      orgA,
      { companyId: companyA, name: "Support block", startsAt: "2026-01-31T00:00:00Z", coveredMinutes: 600, coveragePeriod: "monthly", overageRateCents: 6000 },
      actor,
    );
    const other = await contracts.create(orgA, { companyId: companyA, name: "Other", startsAt: "2026-01-01T00:00:00Z" }, actor);
    await entry("2026-02-28T00:00:00Z", 90, c.id); // first day of the period
    await entry("2026-03-30T23:00:00Z", 30, c.id); // last hour of the period
    await entry("2026-02-27T23:59:00Z", 45, c.id); // previous period
    await entry("2026-03-31T00:00:00Z", 15, c.id); // next period
    await entry("2026-03-10T00:00:00Z", 60, other.id);
    await entry("2026-03-10T00:00:00Z", 60, null);

    const usage = await contracts.usage(orgA, c.id, new Date("2026-03-15T00:00:00Z"));
    expect(usage.period).toEqual({
      start: new Date("2026-02-28T00:00:00Z"),
      end: new Date("2026-03-31T00:00:00Z"),
      coveragePeriod: "monthly",
    });
    expect(usage).toMatchObject({ usedMinutes: 120, remainingMinutes: 480, overageMinutes: 0 });

    await entry("2026-03-01T00:00:00Z", 500, c.id);
    const over = await contracts.usage(orgA, c.id, new Date("2026-03-15T00:00:00Z"));
    expect(over).toMatchObject({ usedMinutes: 620, remainingMinutes: 0, overageMinutes: 20, overageCents: 2000 });

    await expect(contracts.usage(orgB, c.id)).rejects.toThrow("Contract not found");
  });

  it("attaches a time entry only when it belongs to the contract's company", async () => {
    const c = await contracts.create(orgA, { companyId: companyA, name: "Retainer", startsAt: "2026-01-01T00:00:00Z", coveredMinutes: 120 }, actor);
    const e = await entry("2026-10-10T10:00:00Z", 30, null);
    await prisma.timeEntry.update({ where: { id: e.id }, data: { billable: true } });
    await expect(contracts.setTimeEntry(orgA, c.id, e.id, true, actor)).rejects.toThrow(/company/);

    const contact = await prisma.contact.create({ data: { organizationId: orgA, name: "Client", companyId: companyA } });
    await prisma.projectContact.create({ data: { projectId, contactId: contact.id } });
    const attached = await contracts.setTimeEntry(orgA, c.id, e.id, true, actor);
    expect(attached).toMatchObject({ contractId: c.id, billable: false });

    const usage = await contracts.usage(orgA, c.id, new Date("2026-10-15T00:00:00Z"));
    expect(usage.usedMinutes).toBe(30);
    const detached = await contracts.setTimeEntry(orgA, c.id, e.id, false, actor);
    expect(detached).toMatchObject({ contractId: null, billable: true });
    await expect(contracts.setTimeEntry(orgB, c.id, e.id, true, actor)).rejects.toThrow("Contract not found");
  });
});
