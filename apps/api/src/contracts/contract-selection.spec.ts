import { describe, expect, it, mock } from "bun:test";
import { isInForce, pickActiveContract } from "./contract-selection";
import { ContractsService, coverageOf } from "./contracts.service";

const d = (s: string): Date => new Date(s);
const AT = d("2026-10-31T12:00:00Z");

function contract(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: "active",
    startsAt: d("2026-01-01T00:00:00Z"),
    endsAt: null as Date | null,
    createdAt: d("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("isInForce", () => {
  it("needs active status, a past start and a future end", () => {
    expect(isInForce(contract("a"), AT)).toBe(true);
    expect(isInForce(contract("a", { status: "draft" }), AT)).toBe(false);
    expect(isInForce(contract("a", { startsAt: d("2026-11-01T00:00:00Z") }), AT)).toBe(false);
    expect(isInForce(contract("a", { endsAt: AT }), AT)).toBe(false);
  });
});

describe("pickActiveContract", () => {
  it("prefers a fixed term over an open-ended agreement", () => {
    const msa = contract("msa");
    const block = contract("block", { endsAt: d("2027-01-01T00:00:00Z") });
    expect(pickActiveContract([msa, block], AT)?.id).toBe("block");
  });

  it("prefers the shorter term, then the later start", () => {
    const year = contract("year", { endsAt: d("2027-01-01T00:00:00Z") });
    const quarter = contract("quarter", { startsAt: d("2026-10-01T00:00:00Z"), endsAt: d("2027-01-01T00:00:00Z") });
    expect(pickActiveContract([year, quarter], AT)?.id).toBe("quarter");
    const older = contract("older");
    const newer = contract("newer", { startsAt: d("2026-06-01T00:00:00Z") });
    expect(pickActiveContract([older, newer], AT)?.id).toBe("newer");
  });

  it("breaks full ties deterministically and ignores contracts not in force", () => {
    const a = contract("a");
    const b = contract("b");
    expect(pickActiveContract([b, a], AT)?.id).toBe("a");
    expect(pickActiveContract([a, b], AT)?.id).toBe("a");
    expect(pickActiveContract([contract("x", { status: "expired" })], AT)).toBeNull();
  });
});

describe("coverageOf", () => {
  const c = { id: "c1", name: "Support", type: "block_hours", slaPolicyId: "sla1", coveredMinutes: 600 };
  const period = { start: AT, end: null, coveragePeriod: "monthly" };

  it("defaults time to non-billable on the contract while minutes remain", () => {
    const cov = coverageOf(c, { period, coveredMinutes: 600, usedMinutes: 100, remainingMinutes: 500, overageMinutes: 0, overageCents: 0 });
    expect(cov).toMatchObject({ slaPolicyId: "sla1", hasHoursRemaining: true, defaultBillable: false, defaultContractId: "c1" });
  });

  it("falls back to billable once the allowance is used up or there is none", () => {
    const used = coverageOf(c, { period, coveredMinutes: 600, usedMinutes: 600, remainingMinutes: 0, overageMinutes: 0, overageCents: 0 });
    expect(used).toMatchObject({ slaPolicyId: "sla1", defaultBillable: true, defaultContractId: null });
    const none = coverageOf({ ...c, coveredMinutes: null }, null);
    expect(none).toMatchObject({ slaPolicyId: "sla1", hasHoursRemaining: false, defaultBillable: true });
  });
});

describe("ContractsService.coverageFor", () => {
  function build(contracts: unknown[], usedSec: number) {
    const prisma = {
      contract: { findMany: mock(() => Promise.resolve(contracts)) },
      timeEntry: { aggregate: mock(() => Promise.resolve({ _sum: { durationSec: usedSec } })) },
    };
    return { service: new ContractsService(prisma as never, {} as never, {} as never), prisma };
  }
  const full = {
    ...contract("c1", { endsAt: d("2027-01-01T00:00:00Z") }),
    organizationId: "org1",
    name: "Support",
    type: "block_hours",
    slaPolicyId: "sla1",
    coveredMinutes: 120,
    coveragePeriod: "monthly",
    overageRateCents: null,
  };

  it("returns no coverage without a company or contract", async () => {
    const { service, prisma } = build([], 0);
    expect((await service.coverageFor("org1", null, AT)).contract).toBeNull();
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
    expect(await service.coverageFor("org1", "co1", AT)).toMatchObject({ contract: null, defaultBillable: true });
  });

  it("sums the current period's time against the allowance, scoped to the workspace and contract", async () => {
    const { service, prisma } = build([full], 30 * 60);
    const cov = await service.coverageFor("org1", "co1", AT);
    expect(cov).toMatchObject({ defaultContractId: "c1", usage: { usedMinutes: 30, remainingMinutes: 90 } });
    const where = (prisma.contract.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ organizationId: "org1", companyId: "co1", status: "active" });
    const agg = (prisma.timeEntry.aggregate.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(agg).toMatchObject({ organizationId: "org1", contractId: "c1" });
    expect(agg.startedAt).toEqual({ gte: d("2026-10-01T00:00:00Z"), lt: d("2026-11-01T00:00:00Z") });
  });
});
