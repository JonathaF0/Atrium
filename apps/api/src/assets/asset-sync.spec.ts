import { describe, expect, it, mock } from "bun:test";
import { planSync } from "./asset-sync";
import type { SyncAssetInput } from "./asset-sync";
import { AssetSyncService } from "./asset-sync.service";

const companies = [
  { id: "c1", name: "Sample Company" },
  { id: "c2", name: "Example Ltd" },
];

function item(over: Partial<SyncAssetInput> = {}): SyncAssetInput {
  return { externalId: "dev-1", companyId: "c1", type: "device", name: "Laptop 01", ...over };
}

describe("planSync", () => {
  it("creates unknown records as active and updates known ones", () => {
    const plan = planSync(
      [item(), item({ externalId: "dev-2", name: "Server" })],
      [{ id: "a2", externalId: "dev-2", status: "active" }],
      companies,
    );
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].data.status).toBe("active");
    expect(plan.updates).toEqual([
      expect.objectContaining({ id: "a2", externalId: "dev-2", data: expect.objectContaining({ name: "Server" }) }),
    ]);
    expect(plan.errors).toEqual([]);
  });

  it("matches companies by name, case-insensitively", () => {
    const plan = planSync([item({ companyId: undefined, companyName: "  example ltd " })], [], companies);
    expect(plan.creates[0].data.companyId).toBe("c2");
  });

  it("rejects unknown companies (including ids from another workspace) and missing company", () => {
    const plan = planSync(
      [item({ companyId: "other-org-company" }), item({ externalId: "x", companyId: undefined })],
      [],
      companies,
    );
    expect(plan.errors.map((e) => e.reason)).toEqual(["Unknown company", "companyId or companyName is required"]);
    expect(plan.creates).toEqual([]);
  });

  it("rejects duplicate externalIds, bad metadata and bad dates but keeps their ids", () => {
    const plan = planSync(
      [
        item(),
        item(),
        item({ externalId: "m", metadata: { nested: { a: 1 } } as never }),
        item({ externalId: "d", renewsAt: "next week" }),
      ],
      [],
      companies,
    );
    expect(plan.creates).toHaveLength(1);
    expect(plan.errors.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(plan.keepExternalIds).toEqual(["dev-1", "dev-1", "m", "d"]);
  });

  it("reactivates a retired record that reappears unless a status is given", () => {
    const existing = [{ id: "a1", externalId: "dev-1", status: "retired" }];
    expect(planSync([item()], existing, companies).updates[0].data.status).toBe("active");
    expect(planSync([item({ status: "expired" })], existing, companies).updates[0].data.status).toBe("expired");
    const active = [{ id: "a1", externalId: "dev-1", status: "expired" }];
    expect(planSync([item()], active, companies).updates[0].data.status).toBeUndefined();
  });

  it("parses dates and leaves omitted fields undefined", () => {
    const plan = planSync([item({ warrantyEndsAt: "2027-01-31", vendor: null })], [], companies);
    const data = plan.creates[0].data;
    expect(data.warrantyEndsAt?.toISOString()).toBe("2027-01-31T00:00:00.000Z");
    expect(data.vendor).toBeNull();
    expect(data.model).toBeUndefined();
  });
});

describe("AssetSyncService", () => {
  function build(existing: Array<{ id: string; externalId: string; status: string }> = []) {
    const tx = {
      asset: {
        create: mock(() => Promise.resolve({})),
        update: mock(() => Promise.resolve({})),
        updateMany: mock(() => Promise.resolve({ count: 3 })),
      },
    };
    const prisma = {
      company: { findMany: mock(() => Promise.resolve(companies)) },
      asset: { findMany: mock(() => Promise.resolve(existing)) },
      $transaction: mock((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const audit = { record: mock(() => Promise.resolve()) };
    const service = new AssetSyncService(prisma as never, audit as never);
    return { service, prisma, tx, audit };
  }
  const actor = { id: "u1" };

  it("scopes lookups and writes to the workspace and source", async () => {
    const { service, prisma, tx } = build([{ id: "a1", externalId: "dev-1", status: "active" }]);
    const res = await service.sync("org1", "Sample-RMM", [item(), item({ externalId: "dev-2" })], false, actor);
    expect(res).toEqual({ source: "sample-rmm", created: 1, updated: 1, retired: 0, errors: [] });
    const findArgs = (prisma.asset.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(findArgs.where).toMatchObject({ organizationId: "org1", externalSource: "sample-rmm" });
    const companyArgs = (prisma.company.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(companyArgs.where.organizationId).toBe("org1");
    const created = (tx.asset.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(created).toMatchObject({ organizationId: "org1", externalSource: "sample-rmm", externalId: "dev-2" });
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
  });

  it("retires the source's other assets on a full sync", async () => {
    const { service, tx } = build();
    const res = await service.sync("org1", "rmm", [item()], true, actor);
    expect(res.retired).toBe(3);
    const where = (tx.asset.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toEqual({
      organizationId: "org1",
      externalSource: "rmm",
      externalId: { notIn: ["dev-1"] },
      status: { not: "retired" },
    });
  });

  it("refuses bad sources and an empty full sync", async () => {
    const { service } = build();
    await expect(service.sync("org1", "bad source!", [item()], false, actor)).rejects.toThrow(/source/);
    await expect(service.sync("org1", "csv", [item()], false, actor)).rejects.toThrow(/source/);
    await expect(service.sync("org1", "rmm", [], true, actor)).rejects.toThrow(/at least one/);
  });
});
