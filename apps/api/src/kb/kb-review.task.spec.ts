import "reflect-metadata";
import { describe, expect, it, mock } from "bun:test";
import { KbReviewTask } from "./kb-review.task";
import { fakeEmailRenderer } from "../common/testing/fake-email-renderer";

const now = new Date("2026-06-01T07:17:00Z");

function build(claimed: Array<Record<string, unknown>>) {
  const prisma = {
    kbArticle: { findMany: mock(() => Promise.resolve(claimed.map((c) => ({ id: c.id })))) },
    $queryRaw: mock((..._args: unknown[]) => Promise.resolve(claimed)),
    member: {
      findMany: mock(() =>
        Promise.resolve([
          { organizationId: "org", userId: "owner-1", role: "owner", user: { name: "Owner", email: "owner@example.com" } },
          { organizationId: "org", userId: "admin-1", role: "admin", user: { name: "Admin", email: "admin@example.com" } },
        ]),
      ),
    },
    organization: { findMany: mock(() => Promise.resolve([{ id: "org", name: "Sample IT" }])) },
  };
  const mail = { send: mock((..._args: unknown[]) => Promise.resolve({ sent: true, viaOrgConfig: false })) };
  const inApp = { createMany: mock((..._args: unknown[]) => Promise.resolve()) };
  const config = { get: (_k: string, d: string) => d };
  const task = new KbReviewTask(prisma as never, mail as never, fakeEmailRenderer(), inApp as never, config as never);
  return { prisma, mail, inApp, task };
}

const article = (id: string, ownerId: string | null) => ({
  id,
  organizationId: "org",
  title: `Article ${id}`,
  ownerId,
  reviewBy: new Date("2026-05-01T00:00:00Z"),
});

describe("KbReviewTask", () => {
  it("sends one digest per owner covering all their articles", async () => {
    const { task, mail, inApp } = build([article("a1", "admin-1"), article("a2", "admin-1"), article("a3", "owner-1")]);
    expect(await task.notifyDue(now)).toBe(2);
    expect(mail.send).toHaveBeenCalledTimes(2);
    const toAdmin = mail.send.mock.calls.find((c) => c[0] === "admin@example.com")!;
    expect(toAdmin[1]).toBe("2 knowledge base articles are due for review");
    expect(String(toAdmin[2])).toContain("Article a1");
    expect(String(toAdmin[2])).toContain("Article a2");
    expect(String(toAdmin[2])).not.toContain("Article a3");
    expect(inApp.createMany).toHaveBeenCalledTimes(2);
  });

  it("falls back to workspace owners when the article owner is gone", async () => {
    const { task, mail } = build([article("a1", "former-staff"), article("a2", null)]);
    await task.notifyDue(now);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0]).toBe("owner@example.com");
  });

  it("only notifies articles it claimed (another replica may have them)", async () => {
    const { task, mail, prisma } = build([]);
    prisma.kbArticle.findMany.mockResolvedValueOnce([{ id: "a1" }]);
    expect(await task.notifyDue(now)).toBe(0);
    expect(mail.send).not.toHaveBeenCalled();
    const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain(`"reviewNotifiedAt" IS NULL`);
    expect(sql).toContain("RETURNING");
  });

  it("does nothing when no article is due", async () => {
    const { task, prisma } = build([]);
    expect(await task.notifyDue(now)).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
