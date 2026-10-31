import { describe, expect, it } from "bun:test";
import {
  canDismiss,
  canTransition,
  dueAction,
  effectiveExpiry,
  isBannerWorthy,
  isHistory,
  reminderDue,
  showInBanner,
  type LifecycleFields,
} from "./announcement-state";

const NOW = new Date("2026-10-31T12:00:00Z");
const h = (hours: number): Date => new Date(NOW.getTime() + hours * 3_600_000);

function a(over: Partial<LifecycleFields> = {}): LifecycleFields {
  return {
    type: "general",
    severity: "info",
    status: "published",
    incidentState: null,
    publishAt: null,
    expiresAt: null,
    resolvedAt: null,
    windowStart: null,
    windowEnd: null,
    reminderSentAt: null,
    ...over,
  };
}

describe("transitions", () => {
  const cases: [string, string, boolean][] = [
    ["draft", "publish", true],
    ["scheduled", "publish", true],
    ["published", "publish", false],
    ["expired", "publish", false],
    ["draft", "schedule", true],
    ["scheduled", "schedule", true],
    ["published", "schedule", false],
    ["published", "unpublish", true],
    ["scheduled", "unpublish", true],
    ["expired", "unpublish", true],
    ["draft", "unpublish", false],
    ["published", "expire", true],
    ["draft", "expire", false],
    ["scheduled", "expire", false],
  ];
  for (const [from, action, ok] of cases) {
    it(`${from} -> ${action}: ${ok ? "allowed" : "refused"}`, () => {
      expect(canTransition(from, action as "publish")).toBe(ok);
    });
  }
});

describe("scheduler", () => {
  it("publishes a scheduled announcement once publishAt has passed, not before", () => {
    expect(dueAction(a({ status: "scheduled", publishAt: h(-0.01) }), NOW)).toBe("publish");
    expect(dueAction(a({ status: "scheduled", publishAt: NOW }), NOW)).toBe("publish");
    expect(dueAction(a({ status: "scheduled", publishAt: h(1) }), NOW)).toBeNull();
    expect(dueAction(a({ status: "scheduled", publishAt: null }), NOW)).toBeNull();
  });

  it("never publishes drafts", () => {
    expect(dueAction(a({ status: "draft", publishAt: h(-5) }), NOW)).toBeNull();
  });

  it("expires at expiresAt", () => {
    expect(dueAction(a({ expiresAt: h(-1) }), NOW)).toBe("expire");
    expect(dueAction(a({ expiresAt: h(1) }), NOW)).toBeNull();
  });

  it("expires maintenance an hour after the window when no expiry is set", () => {
    const m = { type: "maintenance", windowStart: h(-5) };
    expect(dueAction(a({ ...m, windowEnd: h(-0.5) }), NOW)).toBeNull();
    expect(dueAction(a({ ...m, windowEnd: h(-1) }), NOW)).toBe("expire");
    expect(effectiveExpiry(a({ ...m, windowEnd: h(-2) }))?.toISOString()).toBe(h(-1).toISOString());
  });

  it("an explicit expiry wins over the maintenance window", () => {
    expect(dueAction(a({ type: "maintenance", windowEnd: h(-3), expiresAt: h(2) }), NOW)).toBeNull();
  });

  it("does not expire general announcements without an expiry, or anything not published", () => {
    expect(dueAction(a({ type: "general" }), NOW)).toBeNull();
    expect(dueAction(a({ status: "expired", expiresAt: h(-1) }), NOW)).toBeNull();
    expect(dueAction(a({ status: "draft", expiresAt: h(-1) }), NOW)).toBeNull();
  });

  it("sends the maintenance reminder once, inside the reminder window", () => {
    const m = a({ type: "maintenance", windowStart: h(10), windowEnd: h(12) });
    expect(reminderDue(m, NOW, 24)).toBe(true);
    expect(reminderDue(m, NOW, 6)).toBe(false);
    expect(reminderDue({ ...m, reminderSentAt: h(-1) }, NOW, 24)).toBe(false);
    expect(reminderDue({ ...m, windowStart: h(-1) }, NOW, 24)).toBe(false);
    expect(reminderDue({ ...m, status: "scheduled" }, NOW, 24)).toBe(false);
    expect(reminderDue({ ...m, type: "incident" }, NOW, 24)).toBe(false);
  });
});

describe("dismiss rules", () => {
  it("anything below critical can be dismissed", () => {
    for (const severity of ["info", "minor", "major"]) {
      expect(canDismiss(a({ severity, type: "incident", incidentState: "investigating" }))).toBe(true);
    }
  });

  it("critical incidents stay until resolved", () => {
    const critical = a({ type: "incident", severity: "critical", incidentState: "identified" });
    expect(canDismiss(critical)).toBe(false);
    expect(canDismiss({ ...critical, incidentState: "resolved", resolvedAt: NOW })).toBe(true);
    expect(canDismiss({ ...critical, status: "expired" })).toBe(true);
  });

  it("a dismissed critical incident still shows in the banner; a dismissed minor one does not", () => {
    const critical = a({ type: "incident", severity: "critical", incidentState: "investigating" });
    const minor = { ...critical, severity: "minor" };
    expect(showInBanner(critical, true, NOW)).toBe(true);
    expect(showInBanner(minor, true, NOW)).toBe(false);
    expect(showInBanner(minor, false, NOW)).toBe(true);
  });
});

describe("banner and history", () => {
  it("shows unresolved incidents and upcoming or ongoing maintenance only", () => {
    expect(isBannerWorthy(a({ type: "incident", incidentState: "monitoring" }), NOW)).toBe(true);
    expect(isBannerWorthy(a({ type: "incident", incidentState: "resolved", resolvedAt: NOW }), NOW)).toBe(false);
    expect(isBannerWorthy(a({ type: "maintenance", windowStart: h(5), windowEnd: h(6) }), NOW)).toBe(true);
    expect(isBannerWorthy(a({ type: "maintenance", windowStart: h(-1), windowEnd: h(1) }), NOW)).toBe(true);
    expect(isBannerWorthy(a({ type: "maintenance", windowStart: h(-3), windowEnd: h(-2) }), NOW)).toBe(false);
    expect(isBannerWorthy(a({ type: "general" }), NOW)).toBe(false);
    expect(isBannerWorthy(a({ type: "incident", status: "draft" }), NOW)).toBe(false);
  });

  it("moves resolved incidents and expired announcements to history", () => {
    expect(isHistory(a({ type: "incident", incidentState: "resolved", resolvedAt: NOW }))).toBe(true);
    expect(isHistory(a({ status: "expired" }))).toBe(true);
    expect(isHistory(a({ type: "incident", incidentState: "investigating" }))).toBe(false);
    expect(isHistory(a({ type: "general" }))).toBe(false);
  });
});
