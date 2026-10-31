import { describe, expect, it, mock } from "bun:test";
import { AnnouncementsTask, reminderHours } from "./announcements.task";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../service-core";
import type { AnnouncementNotificationsService } from "./announcement-notifications.service";
import type { ConfigService } from "@nestjs/config";

const NOW = new Date("2026-10-31T12:00:00Z");
const h = (hours: number): Date => new Date(NOW.getTime() + hours * 3_600_000);

interface Row {
  id: string;
  organizationId: string;
  type: string;
  severity: string;
  status: string;
  incidentState: string | null;
  title: string;
  publishAt: Date | null;
  publishedAt: Date | null;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  reminderSentAt: Date | null;
  audiences: { companyId: string }[];
}

function row(id: string, over: Partial<Row>): Row {
  return {
    id,
    organizationId: "org1",
    type: "general",
    severity: "info",
    status: "published",
    incidentState: null,
    title: id,
    publishAt: null,
    publishedAt: h(-48),
    expiresAt: null,
    resolvedAt: null,
    windowStart: null,
    windowEnd: null,
    reminderSentAt: null,
    audiences: [],
    ...over,
  };
}

/** Two task instances share these rows, standing in for two API replicas. */
function build(rows: Row[]) {
  const notifier = { published: mock(async () => 1), maintenanceReminder: mock(async () => 1) };
  const prisma = {
    announcement: {
      findMany: mock(async () => rows.map((r) => ({ ...r }))),
      updateMany: mock(async ({ where, data }: { where: Partial<Row> & { id: string }; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) return { count: 0 };
        if (where.status && r.status !== where.status) return { count: 0 };
        if ("reminderSentAt" in where && r.reminderSentAt !== where.reminderSentAt) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
    },
  };
  const audit = { record: mock(async () => undefined) };
  const config = { get: () => undefined } as unknown as ConfigService;
  const make = (): AnnouncementsTask =>
    new AnnouncementsTask(
      prisma as unknown as PrismaService,
      notifier as unknown as AnnouncementNotificationsService,
      audit as unknown as AuditService,
      config,
    );
  return { a: make(), b: make(), notifier, rows };
}

describe("AnnouncementsTask", () => {
  it("publishes due scheduled announcements exactly once across instances", async () => {
    const { a, b, notifier, rows } = build([
      row("due", { status: "scheduled", publishAt: h(-0.1) }),
      row("later", { status: "scheduled", publishAt: h(2) }),
    ]);
    const [x, y] = await Promise.all([a.publishDue(NOW), b.publishDue(NOW)]);
    expect(x + y).toBe(1);
    expect(notifier.published).toHaveBeenCalledTimes(1);
    expect(rows.find((r) => r.id === "due")?.status).toBe("published");
    expect(rows.find((r) => r.id === "later")?.status).toBe("scheduled");
  });

  it("expires at expiresAt and maintenance an hour after its window", async () => {
    const { a, rows } = build([
      row("expiring", { expiresAt: h(-1) }),
      row("maint-done", { type: "maintenance", windowStart: h(-5), windowEnd: h(-2) }),
      row("maint-grace", { type: "maintenance", windowStart: h(-5), windowEnd: h(-0.5) }),
      row("forever", {}),
    ]);
    expect(await a.expireDue(NOW)).toBe(2);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ["expiring", "expired"],
      ["maint-done", "expired"],
      ["maint-grace", "published"],
      ["forever", "published"],
    ]);
  });

  it("sends a maintenance reminder once", async () => {
    const { a, b, notifier, rows } = build([row("soon", { type: "maintenance", windowStart: h(10), windowEnd: h(12) })]);
    await Promise.all([a.sendReminders(NOW), b.sendReminders(NOW)]);
    await a.sendReminders(NOW);
    expect(notifier.maintenanceReminder).toHaveBeenCalledTimes(1);
    expect(rows[0].reminderSentAt).toEqual(NOW);
  });

  it("skips the reminder when the announcement was published inside the reminder window", async () => {
    const { a, notifier, rows } = build([
      row("late", { type: "maintenance", windowStart: h(10), windowEnd: h(12), publishedAt: h(-1) }),
    ]);
    expect(await a.sendReminders(NOW)).toBe(0);
    expect(notifier.maintenanceReminder).not.toHaveBeenCalled();
    expect(rows[0].reminderSentAt).toEqual(NOW);
  });

  it("reads MAINTENANCE_REMINDER_HOURS with a sane default", () => {
    expect(reminderHours(undefined)).toBe(24);
    expect(reminderHours("6")).toBe(6);
    expect(reminderHours("-1")).toBe(24);
    expect(reminderHours("abc")).toBe(24);
  });
});
