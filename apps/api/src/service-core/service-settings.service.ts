import { Injectable } from "@nestjs/common";
import type { Prisma, ServiceSettings } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";

type Sequence = "ticket" | "estimate";

@Injectable()
export class ServiceSettingsService {
  constructor(private prisma: PrismaService) {}

  get(organizationId: string): Promise<ServiceSettings> {
    return this.prisma.serviceSettings.upsert({
      where: { organizationId },
      create: { organizationId },
      update: {},
    });
  }

  update(organizationId: string, data: Prisma.ServiceSettingsUpdateInput): Promise<ServiceSettings> {
    return this.prisma.serviceSettings.upsert({
      where: { organizationId },
      create: { organizationId, ...(data as Prisma.ServiceSettingsCreateWithoutOrganizationInput) },
      update: data,
    });
  }

  /**
   * Allocates the next human-friendly number for a sequence. The increment is a
   * single UPDATE, so concurrent callers never get the same number.
   */
  async nextNumber(
    organizationId: string,
    sequence: Sequence,
    tx?: Prisma.TransactionClient,
  ): Promise<{ number: number; prefix: string }> {
    const client = tx ?? this.prisma;
    await client.serviceSettings.upsert({ where: { organizationId }, create: { organizationId }, update: {} });
    if (sequence === "ticket") {
      const row = await client.serviceSettings.update({
        where: { organizationId },
        data: { nextTicketNumber: { increment: 1 } },
        select: { nextTicketNumber: true, ticketPrefix: true },
      });
      return { number: row.nextTicketNumber - 1, prefix: row.ticketPrefix };
    }
    const row = await client.serviceSettings.update({
      where: { organizationId },
      data: { nextEstimateNumber: { increment: 1 } },
      select: { nextEstimateNumber: true, estimatePrefix: true },
    });
    return { number: row.nextEstimateNumber - 1, prefix: row.estimatePrefix };
  }
}

export function formatReference(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}
