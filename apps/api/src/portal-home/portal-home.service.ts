import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { TICKET_DONE_STATUSES } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ClientScopeService, clientOwnedWhere, excerpt, formatReference, type ClientScope } from "../service-core";
import { isPrivilegedRole } from "../common";
import { CLIENT_HIDDEN_STATUSES } from "../invoices/invoices.service";
import { calculateInvoiceTotal } from "../payments/invoice-total";
import { getCurrency } from "../common/helpers/currency";
import { AudienceResolver } from "../announcements/audience-resolver.service";
import { AnnouncementsPortalService, type PortalAnnouncement } from "../announcements/announcements-portal.service";

/** Renewal horizon for assets and contracts on the home page. */
export const RENEWAL_WINDOW_DAYS = 60;
const LATEST = 5;
/** Invoices a client is asked to pay; drafts and cancelled ones are never shown (CLIENT_HIDDEN_STATUSES). */
export const OUTSTANDING_INVOICE_STATUSES = ["sent", "overdue"] as const;

/** A section that failed to load is null, so the page renders the rest. */
type Section<T> = T | null;

export interface TicketsSection {
  openCount: number;
  latest: { id: string; reference: string; subject: string; status: string; priority: string; lastActivityAt: Date }[];
}

export interface InvoicesSection {
  currency: string;
  outstandingCount: number;
  overdueCount: number;
  outstandingCents: number;
  latest: {
    id: string;
    invoiceNumber: string;
    status: string;
    dueDate: Date | null;
    amountCents: number;
    projectId: string | null;
    projectName: string | null;
  }[];
}

export interface RenewalsSection {
  assets: { id: string; name: string; type: string; vendor: string | null; kind: "warranty" | "renewal"; date: Date }[];
  /** null when the viewer is not a company admin: contracts are for admins only. */
  contracts: { id: string; name: string; type: string; endsAt: Date; autoRenew: boolean }[] | null;
}

export interface UpdatesSection {
  latest: { id: string; projectId: string; projectName: string; excerpt: string; createdAt: Date }[];
}

export interface AnnouncementsSection {
  unread: number;
  banner: PortalAnnouncement[];
}

export interface PortalHome {
  company: { name: string; companyAdmin: boolean } | null;
  tickets: Section<TicketsSection>;
  invoices: Section<InvoicesSection>;
  renewals: Section<RenewalsSection>;
  updates: Section<UpdatesSection>;
  announcements: Section<AnnouncementsSection>;
  quickActions: { requestProjectId: string | null; payInvoiceProjectId: string | null };
}

/**
 * Everything the portal landing page shows, in one round trip. Each section is
 * scoped on its own and fails soft: an error in one is logged and returns null.
 */
@Injectable()
export class PortalHomeService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private clientScope: ClientScopeService,
    private audience: AudienceResolver,
    private announcements: AnnouncementsPortalService,
    @InjectPinoLogger(PortalHomeService.name) private readonly logger: PinoLogger,
  ) {}

  private async safe<T>(section: string, load: () => Promise<T>): Promise<Section<T>> {
    try {
      return await load();
    } catch (err) {
      this.logger.warn({ err, section }, "Portal home section failed to load");
      return null;
    }
  }

  /** Same visibility as the portal project and invoice lists: assigned projects, or all for owners/admins. */
  private async projectIds(userId: string, organizationId: string, privileged: boolean): Promise<string[]> {
    const projects = await this.prisma.project.findMany({
      where: { organizationId, archivedAt: null, ...(privileged ? {} : { clients: { some: { userId } } }) },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    return projects.map((p) => p.id);
  }

  async get(userId: string, organizationId: string, role?: string, now: Date = new Date()): Promise<PortalHome> {
    const privileged = isPrivilegedRole(role);
    const [scope, projectIds] = await Promise.all([
      this.clientScope.resolve(userId, organizationId),
      this.projectIds(userId, organizationId, privileged),
    ]);

    const [company, tickets, invoices, renewals, updates, announcements] = await Promise.all([
      this.safe("company", () => this.company(scope)),
      this.safe("tickets", () => this.tickets(scope)),
      this.safe("invoices", () => this.invoices(organizationId, projectIds)),
      this.safe("renewals", () => this.renewals(scope, now)),
      this.safe("updates", () => this.updates(organizationId, projectIds)),
      this.safe("announcements", () => this.announcementSection(userId, organizationId, role, now)),
    ]);

    return {
      company: company ?? null,
      tickets,
      invoices,
      renewals,
      updates,
      announcements,
      quickActions: {
        requestProjectId: projectIds[0] ?? null,
        payInvoiceProjectId: invoices?.latest.find((i) => i.projectId)?.projectId ?? null,
      },
    };
  }

  private async company(scope: ClientScope): Promise<{ name: string; companyAdmin: boolean } | null> {
    if (!scope.companyId) return null;
    const company = await this.prisma.company.findFirst({
      where: { id: scope.companyId, organizationId: scope.organizationId },
      select: { name: true },
    });
    return company ? { name: company.name, companyAdmin: scope.companyAdmin } : null;
  }

  async tickets(scope: ClientScope): Promise<TicketsSection> {
    const where = {
      organizationId: scope.organizationId,
      triage: false,
      mergedIntoId: null,
      status: { notIn: [...TICKET_DONE_STATUSES] },
      ...clientOwnedWhere(scope, "requesterUserId"),
    };
    const [openCount, latest, settings] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        orderBy: { lastActivityAt: "desc" },
        take: LATEST,
        select: { id: true, number: true, subject: true, status: true, priority: true, lastActivityAt: true },
      }),
      this.prisma.serviceSettings.findUnique({
        where: { organizationId: scope.organizationId },
        select: { ticketPrefix: true },
      }),
    ]);
    const prefix = settings?.ticketPrefix ?? "TKT";
    return {
      openCount,
      latest: latest.map(({ number, ...t }) => ({ ...t, reference: formatReference(prefix, number) })),
    };
  }

  async invoices(organizationId: string, projectIds: string[]): Promise<InvoicesSection> {
    const currency = getCurrency(this.config);
    if (projectIds.length === 0) {
      return { currency, outstandingCount: 0, overdueCount: 0, outstandingCents: 0, latest: [] };
    }
    const rows = await this.prisma.invoice.findMany({
      where: {
        organizationId,
        projectId: { in: projectIds },
        // Both filters on purpose: never widen past what the portal invoice list allows.
        AND: [{ status: { notIn: CLIENT_HIDDEN_STATUSES } }, { status: { in: [...OUTSTANDING_INVOICE_STATUSES] } }],
      },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        dueDate: true,
        type: true,
        amount: true,
        projectId: true,
        project: { select: { name: true } },
        lineItems: { select: { quantity: true, unitPrice: true } },
      },
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    });
    const mapped = rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      status: r.status,
      dueDate: r.dueDate,
      amountCents: calculateInvoiceTotal(r),
      projectId: r.projectId,
      projectName: r.project?.name ?? null,
    }));
    // Overdue first, then by due date.
    mapped.sort((a, b) => (a.status === b.status ? 0 : a.status === "overdue" ? -1 : 1));
    return {
      currency,
      outstandingCount: mapped.length,
      overdueCount: mapped.filter((i) => i.status === "overdue").length,
      outstandingCents: mapped.reduce((sum, i) => sum + i.amountCents, 0),
      latest: mapped.slice(0, LATEST),
    };
  }

  async renewals(scope: ClientScope, now: Date): Promise<RenewalsSection> {
    if (!scope.companyId) return { assets: [], contracts: scope.companyAdmin ? [] : null };
    const horizon = new Date(now.getTime() + RENEWAL_WINDOW_DAYS * 86_400_000);
    const inWindow = { gte: now, lte: horizon };
    const [assets, contracts] = await Promise.all([
      this.prisma.asset.findMany({
        where: {
          organizationId: scope.organizationId,
          companyId: scope.companyId,
          clientVisible: true,
          status: "active",
          OR: [{ warrantyEndsAt: inWindow }, { renewsAt: inWindow }],
        },
        select: { id: true, name: true, type: true, vendor: true, warrantyEndsAt: true, renewsAt: true },
        take: 50,
      }),
      scope.companyAdmin
        ? this.prisma.contract.findMany({
            where: {
              organizationId: scope.organizationId,
              companyId: scope.companyId,
              status: "active",
              endsAt: inWindow,
            },
            select: { id: true, name: true, type: true, endsAt: true, autoRenew: true },
            orderBy: { endsAt: "asc" },
            take: 20,
          })
        : Promise.resolve(null),
    ]);
    const within = (d: Date | null): d is Date => !!d && d >= now && d <= horizon;
    const assetRows: RenewalsSection["assets"] = [];
    for (const a of assets) {
      if (within(a.renewsAt)) assetRows.push({ id: a.id, name: a.name, type: a.type, vendor: a.vendor, kind: "renewal", date: a.renewsAt });
      if (within(a.warrantyEndsAt)) {
        assetRows.push({ id: a.id, name: a.name, type: a.type, vendor: a.vendor, kind: "warranty", date: a.warrantyEndsAt });
      }
    }
    assetRows.sort((x, y) => x.date.getTime() - y.date.getTime());
    return {
      assets: assetRows.slice(0, 20),
      contracts: contracts
        ? contracts.map((c) => ({ id: c.id, name: c.name, type: c.type, endsAt: c.endsAt as Date, autoRenew: c.autoRenew }))
        : null,
    };
  }

  async updates(organizationId: string, projectIds: string[]): Promise<UpdatesSection> {
    if (projectIds.length === 0) return { latest: [] };
    const rows = await this.prisma.projectUpdate.findMany({
      where: { organizationId, projectId: { in: projectIds } },
      orderBy: { createdAt: "desc" },
      take: LATEST,
      select: { id: true, projectId: true, content: true, createdAt: true, project: { select: { name: true } } },
    });
    return {
      latest: rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        projectName: r.project.name,
        excerpt: excerpt(r.content, 200),
        createdAt: r.createdAt,
      })),
    };
  }

  private async announcementSection(userId: string, organizationId: string, role: string | undefined, now: Date) {
    const viewer = await this.audience.viewer(userId, organizationId, role);
    const [unread, banner] = await Promise.all([
      this.announcements.unreadCount(viewer, now),
      this.announcements.banner(viewer, now),
    ]);
    return { unread, banner };
  }
}
