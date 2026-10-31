/**
 * Audience rules for announcements, as pure predicates. The resolver service
 * loads rows and applies these; nothing else decides who an announcement reaches.
 */

export interface AudienceSpec {
  audienceType: string;
  audienceValue: string | null;
  /** Company ids from AnnouncementAudience rows (only read for "companies"). */
  companyIds: string[];
}

export interface ContractFacts {
  companyId: string;
  type: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  includedServices: string[];
}

export interface AssetFacts {
  companyId: string;
  type: string;
  vendor: string | null;
  status: string;
}

/** What the rules need to know about one portal user. */
export interface ViewerFacts {
  /** null for a portal user without a company: they only ever see "all". */
  companyId: string | null;
  contracts: ContractFacts[];
  assets: AssetFacts[];
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** An active contract (status active, started, not ended) whose type or included services name the value. */
export function contractMatches(contract: ContractFacts, value: string | null, now: Date): boolean {
  const v = norm(value);
  if (!v) return false;
  if (contract.status !== "active") return false;
  if (contract.startsAt.getTime() > now.getTime()) return false;
  if (contract.endsAt && contract.endsAt.getTime() < now.getTime()) return false;
  return contract.type === v || contract.includedServices.some((s) => norm(s) === v);
}

/** An active asset whose vendor or type equals the value, ignoring case. */
export function assetMatches(asset: AssetFacts, value: string | null): boolean {
  const v = norm(value).toLowerCase();
  if (!v) return false;
  if (asset.status !== "active") return false;
  return norm(asset.vendor).toLowerCase() === v || norm(asset.type).toLowerCase() === v;
}

/** True when the company (described by its contracts/assets) is in the audience. */
export function companyInAudience(
  spec: AudienceSpec,
  companyId: string,
  contracts: ContractFacts[],
  assets: AssetFacts[],
  now: Date,
): boolean {
  switch (spec.audienceType) {
    case "all":
      return true;
    case "companies":
      return spec.companyIds.includes(companyId);
    case "contracts":
      return contracts.some((c) => c.companyId === companyId && contractMatches(c, spec.audienceValue, now));
    case "assets":
      return assets.some((a) => a.companyId === companyId && assetMatches(a, spec.audienceValue));
    default:
      // An unknown audience type reaches nobody rather than everybody.
      return false;
  }
}

/** True when a portal user may see the announcement. */
export function viewerInAudience(spec: AudienceSpec, viewer: ViewerFacts, now: Date): boolean {
  if (spec.audienceType === "all") return true;
  if (!viewer.companyId) return false;
  return companyInAudience(spec, viewer.companyId, viewer.contracts, viewer.assets, now);
}

/** Company ids an audience reaches, from the workspace's contracts and assets; "all" for everyone. */
export function companiesForAudience(
  spec: AudienceSpec,
  contracts: ContractFacts[],
  assets: AssetFacts[],
  now: Date,
): "all" | Set<string> {
  switch (spec.audienceType) {
    case "all":
      return "all";
    case "companies":
      return new Set(spec.companyIds);
    case "contracts":
      return new Set(contracts.filter((c) => contractMatches(c, spec.audienceValue, now)).map((c) => c.companyId));
    case "assets":
      return new Set(assets.filter((a) => assetMatches(a, spec.audienceValue)).map((a) => a.companyId));
    default:
      return new Set();
  }
}
