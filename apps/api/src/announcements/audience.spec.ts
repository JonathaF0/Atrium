import { describe, expect, it } from "bun:test";
import {
  assetMatches,
  companiesForAudience,
  contractMatches,
  viewerInAudience,
  type AssetFacts,
  type AudienceSpec,
  type ContractFacts,
  type ViewerFacts,
} from "./audience";

const NOW = new Date("2026-10-31T12:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date("2027-06-01T00:00:00Z");

function contract(companyId: string, over: Partial<ContractFacts> = {}): ContractFacts {
  return { companyId, type: "sla", status: "active", startsAt: PAST, endsAt: null, includedServices: [], ...over };
}

function asset(companyId: string, over: Partial<AssetFacts> = {}): AssetFacts {
  return { companyId, type: "device", vendor: "Sample Vendor", status: "active", ...over };
}

// Workspace fixture:
//   A: active SLA contract with "backup" service, active asset from "Sample Vendor"
//   B: expired SLA contract, retired asset from "Sample Vendor", active "domain" asset
//   C: draft retainer contract starting in the future
//   D: nothing
const CONTRACTS: ContractFacts[] = [
  contract("A", { includedServices: ["backup", "monitoring"] }),
  contract("B", { endsAt: new Date("2026-06-01T00:00:00Z") }),
  contract("C", { type: "retainer", status: "active", startsAt: FUTURE }),
  contract("C", { type: "msa", status: "draft" }),
];
const ASSETS: AssetFacts[] = [
  asset("A"),
  asset("B", { status: "retired" }),
  asset("B", { type: "domain", vendor: null }),
];

function viewer(companyId: string | null): ViewerFacts {
  return {
    companyId,
    contracts: CONTRACTS.filter((c) => c.companyId === companyId),
    assets: ASSETS.filter((a) => a.companyId === companyId),
  };
}

function spec(audienceType: string, audienceValue: string | null = null, companyIds: string[] = []): AudienceSpec {
  return { audienceType, audienceValue, companyIds };
}

// [audience, A, B, C, D, no company]
const MATRIX: [string, AudienceSpec, boolean, boolean, boolean, boolean, boolean][] = [
  ["all", spec("all"), true, true, true, true, true],
  ["companies [A]", spec("companies", null, ["A"]), true, false, false, false, false],
  ["companies [B, D]", spec("companies", null, ["B", "D"]), false, true, false, true, false],
  ["companies []", spec("companies", null, []), false, false, false, false, false],
  ["contracts type sla (only active)", spec("contracts", "sla"), true, false, false, false, false],
  ["contracts included service backup", spec("contracts", "backup"), true, false, false, false, false],
  ["contracts type retainer (not started)", spec("contracts", "retainer"), false, false, false, false, false],
  ["contracts type msa (draft)", spec("contracts", "msa"), false, false, false, false, false],
  ["contracts is case-sensitive on type", spec("contracts", "SLA"), false, false, false, false, false],
  ["contracts empty value", spec("contracts", ""), false, false, false, false, false],
  ["assets vendor (case-insensitive)", spec("assets", "sample VENDOR"), true, false, false, false, false],
  ["assets type domain", spec("assets", "Domain"), false, true, false, false, false],
  ["assets type device (B's device retired)", spec("assets", "device"), true, false, false, false, false],
  ["assets null value", spec("assets", null), false, false, false, false, false],
  ["unknown audience", spec("everyone"), false, false, false, false, false],
];

describe("audience matrix", () => {
  for (const [name, s, a, b, c, d, none] of MATRIX) {
    it(`${name}`, () => {
      expect(viewerInAudience(s, viewer("A"), NOW)).toBe(a);
      expect(viewerInAudience(s, viewer("B"), NOW)).toBe(b);
      expect(viewerInAudience(s, viewer("C"), NOW)).toBe(c);
      expect(viewerInAudience(s, viewer("D"), NOW)).toBe(d);
      expect(viewerInAudience(s, viewer(null), NOW)).toBe(none);
    });

    it(`${name}: recipients agree with what viewers see`, () => {
      const companies = companiesForAudience(s, CONTRACTS, ASSETS, NOW);
      if (companies === "all") {
        expect(s.audienceType).toBe("all");
        return;
      }
      expect(companies.has("A")).toBe(a);
      expect(companies.has("B")).toBe(b);
      expect(companies.has("C")).toBe(c);
      expect(companies.has("D")).toBe(d);
    });
  }

  it("a portal user without a company never matches a targeted audience, even one naming no company", () => {
    const noCompany: ViewerFacts = { companyId: null, contracts: CONTRACTS, assets: ASSETS };
    for (const s of [spec("companies", null, ["A"]), spec("contracts", "sla"), spec("assets", "device")]) {
      expect(viewerInAudience(s, noCompany, NOW)).toBe(false);
    }
  });

  it("ignores another company's contracts and assets passed in by mistake", () => {
    const facts: ViewerFacts = { companyId: "D", contracts: CONTRACTS, assets: ASSETS };
    expect(viewerInAudience(spec("contracts", "sla"), facts, NOW)).toBe(false);
    expect(viewerInAudience(spec("assets", "device"), facts, NOW)).toBe(false);
  });
});

describe("contractMatches", () => {
  it("treats a contract ending today later than now as active and one that ended as inactive", () => {
    expect(contractMatches(contract("A", { endsAt: new Date("2026-10-31T18:00:00Z") }), "sla", NOW)).toBe(true);
    expect(contractMatches(contract("A", { endsAt: new Date("2026-10-31T06:00:00Z") }), "sla", NOW)).toBe(false);
  });

  it("ignores cancelled and expired contracts", () => {
    expect(contractMatches(contract("A", { status: "cancelled" }), "sla", NOW)).toBe(false);
    expect(contractMatches(contract("A", { status: "expired" }), "sla", NOW)).toBe(false);
  });

  it("trims the audience value and included services", () => {
    expect(contractMatches(contract("A", { includedServices: [" backup "] }), "backup ", NOW)).toBe(true);
  });
});

describe("assetMatches", () => {
  it("matches vendor or type, ignoring case and whitespace", () => {
    expect(assetMatches(asset("A", { vendor: "Example Cloud" }), "  example cloud ")).toBe(true);
    expect(assetMatches(asset("A", { type: "ssl_certificate", vendor: null }), "SSL_CERTIFICATE")).toBe(true);
  });

  it("never matches retired or expired assets", () => {
    expect(assetMatches(asset("A", { status: "retired" }), "device")).toBe(false);
    expect(assetMatches(asset("A", { status: "expired" }), "device")).toBe(false);
  });

  it("does not match on partial strings", () => {
    expect(assetMatches(asset("A", { vendor: "Sample Vendor" }), "Sample")).toBe(false);
  });
});
