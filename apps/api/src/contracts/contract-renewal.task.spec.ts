import { describe, expect, it, mock } from "bun:test";
import "../common/testing/mock-email";
import { ContractRenewalTask } from "./contract-renewal.task";

const NOW = new Date("2026-10-31T07:10:00Z");

function build(opts: { renew?: unknown[]; expire?: unknown[]; upcoming?: unknown[]; claim?: number } = {}) {
  const tx = { contract: { updateMany: mock(() => Promise.resolve({ count: opts.claim ?? 1 })) } };
  const findMany = mock((args: { where: Record<string, unknown> }) => {
    if (args.where.autoRenew === true) return Promise.resolve(opts.renew ?? []);
    if (args.where.autoRenew === false) return Promise.resolve(opts.expire ?? []);
    return Promise.resolve(opts.upcoming ?? []);
  });
  const prisma = {
    contract: { findMany, updateMany: mock(() => Promise.resolve({ count: opts.claim ?? 1 })) },
    $transaction: mock((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const notifier = {
    staff: mock(() => Promise.resolve([{ userId: "u1", email: "owner@example.com" }])),
    inAppDigest: mock(() => Promise.resolve()),
    emailDigest: mock(() => Promise.resolve(1)),
  };
  const audit = { record: mock(() => Promise.resolve()) };
  const task = new ContractRenewalTask(prisma as never, notifier as never, audit as never);
  return { task, prisma, tx, notifier, audit };
}

describe("ContractRenewalTask", () => {
  it("auto-renews by the original term and audits it", async () => {
    const c = {
      id: "c1",
      organizationId: "org1",
      name: "Managed services",
      startsAt: new Date("2025-10-31T00:00:00Z"),
      endsAt: new Date("2026-10-31T00:00:00Z"),
    };
    const { task, tx, audit } = build({ renew: [c] });
    const res = await task.runOnce(NOW);
    expect(res.renewed).toBe(1);
    expect((tx.contract.updateMany.mock.calls[0] as unknown as [{ where: unknown; data: unknown }])[0]).toEqual({
      where: { id: "c1", status: "active", endsAt: c.endsAt },
      data: {
        startsAt: new Date("2026-10-31T00:00:00Z"),
        endsAt: new Date("2027-10-31T00:00:00Z"),
        renewalNotifiedAt: null,
      },
    });
    const entry = (audit.record.mock.calls[0] as unknown as [{ action: string; actorId?: string; targetId: string }])[0];
    expect(entry).toMatchObject({ action: "contract.renewed", targetId: "c1" });
    expect(entry.actorId).toBeUndefined();
  });

  it("does not renew or audit twice when another run got there first", async () => {
    const c = {
      id: "c1",
      organizationId: "org1",
      name: "X",
      startsAt: new Date("2025-10-31T00:00:00Z"),
      endsAt: new Date("2026-10-31T00:00:00Z"),
    };
    const { task, audit } = build({ renew: [c], claim: 0 });
    expect((await task.runOnce(NOW)).renewed).toBe(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("expires ended contracts that don't auto-renew", async () => {
    const { task, prisma, audit } = build({ expire: [{ id: "c2", organizationId: "org1", name: "Old" }] });
    expect((await task.runOnce(NOW)).expired).toBe(1);
    expect((prisma.contract.updateMany.mock.calls[0] as unknown as [{ data: unknown }])[0].data).toEqual({ status: "expired" });
    expect((audit.record.mock.calls[0] as unknown as [{ action: string }])[0].action).toBe("contract.expired");
  });

  it("sends a notice once for contracts inside their own window", async () => {
    const upcoming = [
      {
        id: "c3",
        organizationId: "org1",
        name: "Backup service",
        status: "active",
        startsAt: new Date("2026-01-01T00:00:00Z"),
        endsAt: new Date("2026-11-15T00:00:00Z"),
        autoRenew: false,
        renewalNoticeDays: 30,
        renewalNotifiedAt: null,
        company: { name: "Sample Company" },
      },
      {
        id: "c4",
        organizationId: "org1",
        name: "Not yet",
        status: "active",
        startsAt: new Date("2026-01-01T00:00:00Z"),
        endsAt: new Date("2026-12-31T00:00:00Z"),
        autoRenew: true,
        renewalNoticeDays: 14,
        renewalNotifiedAt: null,
        company: { name: "Sample Company" },
      },
    ];
    const { task, tx, notifier } = build({ upcoming });
    expect((await task.runOnce(NOW)).notified).toBe(1);
    expect(tx.contract.updateMany).toHaveBeenCalledTimes(1);
    const digest = (notifier.emailDigest.mock.calls[0] as unknown as [string, unknown, { title: string; items: unknown[] }])[2];
    expect(digest.title).toBe("Contract ending soon: Backup service");
    expect(digest.items).toHaveLength(1);
  });
});
