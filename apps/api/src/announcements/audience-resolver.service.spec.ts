import { describe, expect, it, mock } from "bun:test";
import { AudienceResolver } from "./audience-resolver.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ClientScopeService } from "../service-core";

const NOW = new Date("2026-10-31T12:00:00Z");

const COMPANIES = ["A", "B", "C"];
const MEMBERS = [
  { userId: "ua1", role: "member" },
  { userId: "ua2", role: "member" },
  { userId: "ub1", role: "member" },
  { userId: "unone", role: "member" },
  { userId: "staff", role: "owner" },
];
const CONTACTS = [
  { userId: "ua1", companyId: "A" },
  { userId: "ua2", companyId: "A" },
  { userId: "ub1", companyId: "B" },
  { userId: "unone", companyId: null },
  // A staff member listed as a contact of A must not receive client announcements.
  { userId: "staff", companyId: "A" },
  // A contact whose portal access was removed (no membership) is skipped too.
  { userId: "gone", companyId: "B" },
];

function build() {
  const prisma = {
    member: {
      findMany: mock(async ({ where }: { where: { role: string } }) => MEMBERS.filter((m) => m.role === where.role)),
    },
    contact: {
      findMany: mock(async ({ where }: { where: { companyId: { in: string[] } } }) =>
        CONTACTS.filter((c) => c.companyId && where.companyId.in.includes(c.companyId)),
      ),
    },
    company: {
      findMany: mock(async ({ where }: { where: { id: { in: string[] } } }) =>
        COMPANIES.filter((id) => where.id.in.includes(id)).map((id) => ({ id })),
      ),
      count: mock(async () => COMPANIES.length),
    },
    contract: {
      findMany: mock(async () => [
        { companyId: "A", type: "sla", status: "active", startsAt: new Date("2026-01-01"), endsAt: null, includedServices: ["backup"] },
        { companyId: "B", type: "sla", status: "active", startsAt: new Date("2026-01-01"), endsAt: new Date("2026-02-01"), includedServices: [] },
      ]),
    },
    asset: {
      findMany: mock(async () => [{ companyId: "B", type: "device", vendor: "Sample Vendor", status: "active" }]),
    },
  };
  const resolver = new AudienceResolver(prisma as unknown as PrismaService, {} as ClientScopeService);
  return { resolver, prisma };
}

describe("AudienceResolver recipients and preview", () => {
  it("all reaches every portal user and no staff", async () => {
    const { resolver } = build();
    const ids = await resolver.recipientUserIds("org1", { audienceType: "all", audienceValue: null }, NOW);
    expect(ids.sort()).toEqual(["ua1", "ua2", "ub1", "unone"]);
  });

  it("companies reaches only portal users of those companies", async () => {
    const { resolver } = build();
    const ids = await resolver.recipientUserIds(
      "org1",
      { audienceType: "companies", audienceValue: null, audiences: [{ companyId: "A" }] },
      NOW,
    );
    expect(ids.sort()).toEqual(["ua1", "ua2"]);
  });

  it("drops company ids that are not in the workspace", async () => {
    const { resolver } = build();
    const companies = await resolver.companies(
      "org1",
      { audienceType: "companies", audienceValue: null, audiences: [{ companyId: "A" }, { companyId: "foreign" }] },
      NOW,
    );
    expect(companies).toEqual(new Set(["A"]));
  });

  it("contracts reaches companies with an active matching contract", async () => {
    const { resolver } = build();
    expect(await resolver.recipientUserIds("org1", { audienceType: "contracts", audienceValue: "sla" }, NOW)).toEqual(
      expect.arrayContaining(["ua1", "ua2"]),
    );
    const ids = await resolver.recipientUserIds("org1", { audienceType: "contracts", audienceValue: "sla" }, NOW);
    expect(ids).not.toContain("ub1");
    expect(await resolver.recipientUserIds("org1", { audienceType: "contracts", audienceValue: "backup" }, NOW)).toHaveLength(2);
  });

  it("assets matches vendor case-insensitively", async () => {
    const { resolver } = build();
    expect(await resolver.recipientUserIds("org1", { audienceType: "assets", audienceValue: "SAMPLE vendor" }, NOW)).toEqual([
      "ub1",
    ]);
  });

  it("an audience that matches nothing reaches nobody", async () => {
    const { resolver, prisma } = build();
    expect(await resolver.recipientUserIds("org1", { audienceType: "assets", audienceValue: "none" }, NOW)).toEqual([]);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  it("preview counts companies and recipients from the same resolution", async () => {
    const { resolver } = build();
    expect(await resolver.preview("org1", { audienceType: "all", audienceValue: null }, NOW)).toEqual({
      companyCount: 3,
      recipientCount: 4,
    });
    expect(
      await resolver.preview("org1", { audienceType: "companies", audienceValue: null, audiences: [{ companyId: "B" }] }, NOW),
    ).toEqual({ companyCount: 1, recipientCount: 1 });
  });
});
