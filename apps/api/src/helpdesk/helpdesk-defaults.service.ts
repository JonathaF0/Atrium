import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { DEFAULT_BUSINESS_SCHEDULE, DEFAULT_SLA_TARGETS, DEFAULT_TICKET_CATEGORIES } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { isValidTimeZone } from "../common/helpers/local-time";

export const DEFAULT_CALENDAR_NAME = "Business hours";
export const DEFAULT_SLA_NAME = "Standard";

/**
 * Gives every workspace its helpdesk starting point: the default ticket
 * categories, a business-hours calendar, and a "Standard" SLA policy set as
 * the workspace default. Runs for all workspaces on boot and lazily (once per
 * process) before any helpdesk code needs it. Idempotent: an existing row with
 * the same name is left alone, and a workspace that already has a default
 * policy keeps it. A workspace that deleted every category or
 * policy gets the defaults back on the next boot; clearing only the default
 * policy (no SLA) is respected.
 */
@Injectable()
export class HelpdeskDefaultsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HelpdeskDefaultsService.name);
  private readonly ensured = new Set<string>();

  constructor(private prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    void this.backfill().catch((err: unknown) => this.logger.error("Failed to backfill helpdesk defaults", err));
  }

  async backfill(): Promise<void> {
    const orgs: { id: string }[] = await this.prisma.organization.findMany({
      where: { OR: [{ serviceSettings: null }, { slaPolicies: { none: {} } }, { ticketCategories: { none: {} } }] },
      select: { id: true },
    });
    for (const org of orgs) {
      try {
        await this.ensure(org.id);
      } catch (err) {
        this.logger.error(`Failed to create helpdesk defaults for organization ${org.id}`, err);
      }
    }
  }

  async ensure(organizationId: string): Promise<void> {
    if (this.ensured.has(organizationId)) return;
    const settings = await this.prisma.serviceSettings.upsert({
      where: { organizationId },
      create: { organizationId },
      update: {},
    });
    const hasCategories: number = await this.prisma.ticketCategory.count({ where: { organizationId } });
    if (hasCategories === 0) {
      await this.prisma.ticketCategory.createMany({
        data: DEFAULT_TICKET_CATEGORIES.map((c, i) => ({ ...c, organizationId, order: i })),
        skipDuplicates: true,
      });
    }
    const hasPolicies: number = await this.prisma.slaPolicy.count({ where: { organizationId } });
    if (!settings.defaultSlaPolicyId && hasPolicies === 0) {
      const system = await this.prisma.systemSettings.findUnique({
        where: { organizationId },
        select: { timezone: true },
      });
      const timezone: string = system?.timezone && isValidTimeZone(system.timezone) ? system.timezone : "UTC";
      const calendar = await this.prisma.businessHours.upsert({
        where: { organizationId_name: { organizationId, name: DEFAULT_CALENDAR_NAME } },
        create: { organizationId, name: DEFAULT_CALENDAR_NAME, timezone, schedule: DEFAULT_BUSINESS_SCHEDULE },
        update: {},
      });
      const policy = await this.prisma.slaPolicy.upsert({
        where: { organizationId_name: { organizationId, name: DEFAULT_SLA_NAME } },
        create: {
          organizationId,
          name: DEFAULT_SLA_NAME,
          targets: DEFAULT_SLA_TARGETS as object,
          businessHoursId: calendar.id,
        },
        update: {},
      });
      await this.prisma.serviceSettings.updateMany({
        where: { organizationId, defaultSlaPolicyId: null },
        data: { defaultSlaPolicyId: policy.id },
      });
    }
    this.ensured.add(organizationId);
  }
}
