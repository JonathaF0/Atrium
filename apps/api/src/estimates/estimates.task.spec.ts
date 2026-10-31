import { describe, expect, it, mock } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import type { EstimateNotificationsService } from "./estimate-notifications.service";
import { EstimatesTask, reminderDays } from "./estimates.task";

function setup(env: Record<string, string> = {}) {
  const prisma = {
    estimate: {
      findMany: mock((): Promise<unknown[]> => Promise.resolve([])),
      updateMany: mock(() => Promise.resolve({ count: 1 })),
    },
    estimateEvent: { create: mock(() => Promise.resolve({})) },
    $transaction: mock((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const notifications = { sendReminder: mock(() => Promise.resolve(true)) };
  const task = new EstimatesTask(
    prisma as unknown as PrismaService,
    notifications as unknown as EstimateNotificationsService,
    { get: (k: string) => env[k] } as unknown as ConfigService,
  );
  return { prisma, notifications, task };
}

const now = new Date("2026-06-01T06:10:00Z");

describe("reminderDays", () => {
  it("defaults to 3 and accepts sensible values", () => {
    expect(reminderDays(undefined)).toBe(3);
    expect(reminderDays("abc")).toBe(3);
    expect(reminderDays("7")).toBe(7);
    expect(reminderDays("0")).toBe(0);
  });
});

describe("EstimatesTask.expire", () => {
  it("expires overdue sent estimates with a guarded update and an event", async () => {
    const { prisma, task } = setup();
    prisma.estimate.findMany.mockImplementationOnce(() => Promise.resolve([{ id: "e1" }, { id: "e2" }]));
    prisma.estimate.updateMany
      .mockImplementationOnce(() => Promise.resolve({ count: 1 }))
      .mockImplementationOnce(() => Promise.resolve({ count: 0 }));
    expect(await task.expire(now)).toBe(1);
    const where = (prisma.estimate.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ id: "e1", status: { in: ["sent", "viewed"] }, validUntil: { lt: now } });
    expect(prisma.estimateEvent.create).toHaveBeenCalledTimes(1);
  });
});

describe("EstimatesTask.remind", () => {
  const row = { id: "e1", lineItems: [], discountType: null, discountValue: null, depositPercent: null };

  it("claims each estimate before sending one reminder", async () => {
    const { prisma, notifications, task } = setup();
    prisma.estimate.findMany.mockImplementationOnce(() => Promise.resolve([row]));
    expect(await task.remind(now)).toBe(1);
    const claim = (prisma.estimate.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(claim).toEqual({ id: "e1", expiryReminderSentAt: null });
    expect(notifications.sendReminder).toHaveBeenCalledTimes(1);
    const find = (prisma.estimate.findMany.mock.calls[0] as unknown as [{ where: { validUntil: { lte: Date } } }])[0].where;
    expect(find.validUntil.lte.getTime()).toBe(now.getTime() + 3 * 86_400_000);
  });

  it("skips estimates another instance already claimed", async () => {
    const { prisma, notifications, task } = setup();
    prisma.estimate.findMany.mockImplementationOnce(() => Promise.resolve([row]));
    prisma.estimate.updateMany.mockImplementationOnce(() => Promise.resolve({ count: 0 }));
    expect(await task.remind(now)).toBe(0);
    expect(notifications.sendReminder).not.toHaveBeenCalled();
  });

  it("is disabled with ESTIMATE_REMINDER_DAYS=0", async () => {
    const { prisma, task } = setup({ ESTIMATE_REMINDER_DAYS: "0" });
    expect(await task.remind(now)).toBe(0);
    expect(prisma.estimate.findMany).not.toHaveBeenCalled();
  });
});
