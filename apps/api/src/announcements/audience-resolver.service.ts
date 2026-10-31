import { Injectable } from "@nestjs/common";
import { ROLES } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ClientScopeService } from "../service-core";
import { isPrivilegedRole } from "../common";
import {
  companiesForAudience,
  viewerInAudience,
  type AssetFacts,
  type AudienceSpec,
  type ContractFacts,
  type ViewerFacts,
} from "./audience";

/** A portal reader. Owners/admins outside preview mode see every announcement. */
export interface Viewer {
  userId: string;
  organizationId: string;
  privileged: boolean;
  facts: ViewerFacts;
}

/** The announcement fields the audience rules read. */
export interface AudienceSource {
  audienceType: string;
  audienceValue: string | null;
  audiences?: { companyId: string }[];
}

export function toSpec(source: AudienceSource): AudienceSpec {
  return {
    audienceType: source.audienceType,
    audienceValue: source.audienceValue,
    companyIds: (source.audiences ?? []).map((a) => a.companyId),
  };
}

const CONTRACT_SELECT = {
  companyId: true,
  type: true,
  status: true,
  startsAt: true,
  endsAt: true,
  includedServices: true,
} as const;

const ASSET_SELECT = { companyId: true, type: true, vendor: true, status: true } as const;

/**
 * The single place that decides who an announcement reaches. Used by the portal
 * feed, banner and unread count, by email/push/in-app delivery, and by the staff
 * audience preview, so the count staff see is the set that is notified.
 */
@Injectable()
export class AudienceResolver {
  constructor(
    private prisma: PrismaService,
    private clientScope: ClientScopeService,
  ) {}

  async viewer(userId: string, organizationId: string, role?: string): Promise<Viewer> {
    if (isPrivilegedRole(role)) {
      return { userId, organizationId, privileged: true, facts: { companyId: null, contracts: [], assets: [] } };
    }
    const scope = await this.clientScope.resolve(userId, organizationId);
    if (!scope.companyId) {
      return { userId, organizationId, privileged: false, facts: { companyId: null, contracts: [], assets: [] } };
    }
    const [contracts, assets] = await Promise.all([
      this.prisma.contract.findMany({
        where: { organizationId, companyId: scope.companyId, status: "active" },
        select: CONTRACT_SELECT,
      }),
      this.prisma.asset.findMany({
        where: { organizationId, companyId: scope.companyId, status: "active" },
        select: ASSET_SELECT,
      }),
    ]);
    return {
      userId,
      organizationId,
      privileged: false,
      facts: { companyId: scope.companyId, contracts, assets },
    };
  }

  canSee(viewer: Viewer, source: AudienceSource, now: Date = new Date()): boolean {
    if (viewer.privileged) return true;
    return viewerInAudience(toSpec(source), viewer.facts, now);
  }

  filterVisible<T extends AudienceSource>(viewer: Viewer, items: T[], now: Date = new Date()): T[] {
    return items.filter((item) => this.canSee(viewer, item, now));
  }

  /** Companies an audience reaches; "all" means every portal user of the workspace. */
  async companies(organizationId: string, source: AudienceSource, now: Date = new Date()): Promise<"all" | Set<string>> {
    const spec = toSpec(source);
    let contracts: ContractFacts[] = [];
    let assets: AssetFacts[] = [];
    if (spec.audienceType === "contracts") {
      contracts = await this.prisma.contract.findMany({
        where: { organizationId, status: "active" },
        select: CONTRACT_SELECT,
      });
    } else if (spec.audienceType === "assets") {
      assets = await this.prisma.asset.findMany({
        where: { organizationId, status: "active" },
        select: ASSET_SELECT,
      });
    } else if (spec.audienceType === "companies" && spec.companyIds.length > 0) {
      // Only companies of this workspace count, whatever the rows say.
      const rows = await this.prisma.company.findMany({
        where: { organizationId, id: { in: spec.companyIds } },
        select: { id: true },
      });
      spec.companyIds = rows.map((r) => r.id);
    }
    return companiesForAudience(spec, contracts, assets, now);
  }

  /** Portal users (member role) the announcement reaches. */
  async recipientUserIds(organizationId: string, source: AudienceSource, now: Date = new Date()): Promise<string[]> {
    const companies = await this.companies(organizationId, source, now);
    const members = await this.prisma.member.findMany({
      where: { organizationId, role: ROLES.MEMBER },
      select: { userId: true },
    });
    const portalUsers = new Set(members.map((m) => m.userId));
    if (companies === "all") return [...portalUsers];
    if (companies.size === 0) return [];
    const contacts = await this.prisma.contact.findMany({
      where: { organizationId, companyId: { in: [...companies] }, userId: { not: null } },
      select: { userId: true },
    });
    const ids = new Set<string>();
    for (const c of contacts) if (c.userId && portalUsers.has(c.userId)) ids.add(c.userId);
    return [...ids];
  }

  /** What staff see before sending: how many companies and portal users the audience reaches. */
  async preview(
    organizationId: string,
    source: AudienceSource,
    now: Date = new Date(),
  ): Promise<{ companyCount: number; recipientCount: number }> {
    const [companies, recipients] = await Promise.all([
      this.companies(organizationId, source, now),
      this.recipientUserIds(organizationId, source, now),
    ]);
    const companyCount =
      companies === "all" ? await this.prisma.company.count({ where: { organizationId } }) : companies.size;
    return { companyCount, recipientCount: recipients.length };
  }
}
