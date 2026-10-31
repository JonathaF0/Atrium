import { describe, expect, it, mock } from "bun:test";
import "../common/testing/mock-email";
import { fakeEmailRenderer } from "../common/testing/fake-email-renderer";
import { AssetRenewalTask, assetNoticeDays } from "./asset-renewal.task";
import { RenewalNotifier } from "./renewal-notifier";

const NOW = new Date("2026-10-01T07:00:00Z");

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    organizationId: "org1",
    name: "Office suite",
    type: "software_license",
    status: "active",
    warrantyEndsAt: null,
    renewsAt: new Date("2026-10-15T00:00:00Z"),
    renewalNotifiedAt: null,
    company: { name: "Sample Company" },
    ...over,
  };
}

function build(opts: { assets?: unknown[]; claim?: number; days?: string } = {}) {
  const tx = {
    asset: { updateMany: mock(() => Promise.resolve({ count: opts.claim ?? 1 })) },
    notification: { createMany: mock(() => Promise.resolve({ count: 1 })) },
  };
  const prisma = {
    asset: {
      findMany: mock(() => Promise.resolve(opts.assets ?? [asset()])),
      updateMany: mock(() => Promise.resolve({ count: 2 })),
    },
    member: {
      findMany: mock(() =>
        Promise.resolve([
          { userId: "u1", user: { email: "owner@example.com" } },
          { userId: "u2", user: { email: "admin@example.com" } },
        ]),
      ),
    },
    organization: { findUnique: mock(() => Promise.resolve({ name: "Sample Workspace" })) },
    $transaction: mock((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const inApp = { createMany: mock(() => Promise.resolve()) };
  const mail = { send: mock(() => Promise.resolve({ sent: true, viaOrgConfig: false })) };
  const config = {
    get: (k: string, fallback?: string) =>
      k === "ASSET_RENEWAL_NOTICE_DAYS" ? opts.days : k === "WEB_URL" ? "https://portal.example.com" : fallback,
  };
  const notifier = new RenewalNotifier(prisma as never, inApp as never, mail as never, config as never, fakeEmailRenderer());
  const task = new AssetRenewalTask(prisma as never, notifier, config as never);
  return { task, prisma, tx, inApp, mail };
}

describe("assetNoticeDays", () => {
  it("defaults to 30 and accepts 1-365", () => {
    expect(assetNoticeDays(undefined)).toBe(30);
    expect(assetNoticeDays("abc")).toBe(30);
    expect(assetNoticeDays("0")).toBe(30);
    expect(assetNoticeDays("60")).toBe(60);
  });
});

describe("AssetRenewalTask", () => {
  it("flags lapsed licenses, certificates and domains as expired", async () => {
    const { task, prisma } = build({ assets: [] });
    await task.runOnce(NOW);
    const args = (prisma.asset.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: unknown }])[0];
    expect(args.data).toEqual({ status: "expired" });
    expect(args.where).toMatchObject({ status: "active", type: { in: ["software_license", "ssl_certificate", "domain"] } });
  });

  it("claims due assets, notifies each owner/admin in-app and sends one email each", async () => {
    const { task, tx, inApp, mail } = build({
      assets: [asset(), asset({ id: "a2", name: "Firewall", type: "device", renewsAt: null, warrantyEndsAt: new Date("2026-10-20T00:00:00Z") })],
    });
    const res = await task.runOnce(NOW);
    expect(res.notified).toBe(2);
    expect(tx.asset.updateMany).toHaveBeenCalledTimes(2);
    expect((tx.asset.updateMany.mock.calls[0] as unknown as [{ where: unknown; data: unknown }])[0]).toEqual({
      where: { id: "a1", renewalNotifiedAt: null },
      data: { renewalNotifiedAt: NOW },
    });
    const rows = (inApp.createMany.mock.calls[0] as unknown as [Array<{ userId: string; title: string; link: string }>])[0];
    expect(rows.map((r) => r.userId)).toEqual(["u1", "u2"]);
    expect(rows[0].title).toBe("2 assets up for renewal");
    expect(mail.send).toHaveBeenCalledTimes(2);
    const html = (mail.send.mock.calls[0] as unknown as [string, string, string])[2];
    expect(html).toContain("Firewall");
    expect(html).toContain("https://portal.example.com/dashboard/assets");
  });

  it("skips assets another run already claimed", async () => {
    const { task, inApp, mail } = build({ claim: 0 });
    expect((await task.runOnce(NOW)).notified).toBe(0);
    expect(inApp.createMany).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("does not repeat a notice inside the same window, and honours the configured window", async () => {
    const notified = build({ assets: [asset({ renewalNotifiedAt: new Date("2026-09-20T07:00:00Z") })] });
    expect((await notified.task.runOnce(NOW)).notified).toBe(0);

    const narrow = build({ days: "7" });
    expect((await narrow.task.runOnce(NOW)).notified).toBe(0);
  });
});
