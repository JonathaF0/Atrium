import { describe, expect, it, mock } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { DunningTask } from "./dunning.task";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../service-core";
import type { RecurringNotificationsService } from "./recurring-notifications.service";

const now = new Date("2026-03-20T10:00:00.000Z");

function setup(invoices: Array<{ id: string; dueDate: Date; dunningStage: number }>, opts: { claim?: boolean; days?: string } = {}) {
  const prisma = {
    invoice: {
      findMany: mock(() =>
        Promise.resolve(invoices.map((i) => ({ ...i, organizationId: "org-1", invoiceNumber: `INV-${i.id}` }))),
      ),
      updateMany: mock(() => Promise.resolve({ count: opts.claim === false ? 0 : 1 })),
    },
  };
  const notices = { overdueReminder: mock(() => Promise.resolve(1)) };
  const audit = { record: mock(() => Promise.resolve()) };
  const config = { get: () => opts.days };
  const task = new DunningTask(
    prisma as unknown as PrismaService,
    notices as unknown as RecurringNotificationsService,
    audit as unknown as AuditService,
    config as unknown as ConfigService,
  );
  return { task, prisma, notices, audit };
}

describe("DunningTask", () => {
  it("sends the reminder for the stage an invoice has reached", async () => {
    const { task, prisma, notices, audit } = setup([
      { id: "a", dueDate: new Date("2026-03-16T12:00:00Z"), dunningStage: 0 }, // 3 days overdue
      { id: "b", dueDate: new Date("2026-03-12T12:00:00Z"), dunningStage: 1 }, // 7 days, stage 1 sent
      { id: "c", dueDate: new Date("2026-03-18T12:00:00Z"), dunningStage: 0 }, // 1 day: nothing yet
    ]);
    expect(await task.sendDue(now)).toBe(2);
    expect(notices.overdueReminder.mock.calls).toEqual([
      ["a", 1, 3],
      ["b", 2, 7],
    ]);
    // Claimed by a conditional update on the stage it read.
    expect(prisma.invoice.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "a", dunningStage: 0 },
      data: { dunningStage: 1, lastDunningAt: now },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "invoice.reminder_sent", targetId: "a" }));
  });

  it("does not send when another replica claimed the stage first", async () => {
    const { task, notices } = setup([{ id: "a", dueDate: new Date("2026-03-10T12:00:00Z"), dunningStage: 0 }], { claim: false });
    expect(await task.sendDue(now)).toBe(0);
    expect(notices.overdueReminder).not.toHaveBeenCalled();
  });

  it("jumps straight to the latest stage instead of sending a burst", async () => {
    const { task, notices } = setup([{ id: "a", dueDate: new Date("2026-02-01T12:00:00Z"), dunningStage: 0 }]);
    await task.sendDue(now);
    expect(notices.overdueReminder.mock.calls).toEqual([["a", 3, 46]]);
  });

  it("is off when DUNNING_DAYS is empty", async () => {
    const { task, prisma } = setup([{ id: "a", dueDate: new Date("2026-03-01T12:00:00Z"), dunningStage: 0 }], { days: "" });
    expect(await task.sendDue(now)).toBe(0);
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });
});
