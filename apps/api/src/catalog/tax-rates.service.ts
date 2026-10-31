import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { TaxRate } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { CreateTaxRateDto, UpdateTaxRateDto } from "./tax-rates.dto";

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: string }).code === "P2002";
}

@Injectable()
export class TaxRatesService {
  constructor(private prisma: PrismaService) {}

  list(orgId: string, includeArchived = false): Promise<TaxRate[]> {
    return this.prisma.taxRate.findMany({
      where: { organizationId: orgId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
  }

  /** The default rate in basis points, or 0 when none is set. */
  async defaultRateBps(orgId: string): Promise<number> {
    const rate = await this.prisma.taxRate.findFirst({
      where: { organizationId: orgId, isDefault: true, archivedAt: null },
      select: { rateBps: true },
    });
    return rate?.rateBps ?? 0;
  }

  async create(orgId: string, dto: CreateTaxRateDto): Promise<TaxRate> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault) {
          await tx.taxRate.updateMany({ where: { organizationId: orgId, isDefault: true }, data: { isDefault: false } });
        }
        return tx.taxRate.create({
          data: { organizationId: orgId, name: dto.name.trim(), rateBps: dto.rateBps, isDefault: !!dto.isDefault },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A tax rate with this name already exists");
      throw err;
    }
  }

  async update(orgId: string, id: string, dto: UpdateTaxRateDto): Promise<TaxRate> {
    const existing = await this.prisma.taxRate.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException("Tax rate not found");
    const archivedAt = dto.archived === undefined ? undefined : dto.archived ? (existing.archivedAt ?? new Date()) : null;
    // An archived rate can't stay the default.
    const isDefault = dto.archived ? false : dto.isDefault;
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (isDefault) {
          await tx.taxRate.updateMany({
            where: { organizationId: orgId, isDefault: true, id: { not: id } },
            data: { isDefault: false },
          });
        }
        return tx.taxRate.update({
          where: { id },
          data: { name: dto.name?.trim(), rateBps: dto.rateBps, isDefault, archivedAt },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("A tax rate with this name already exists");
      throw err;
    }
  }

  async remove(orgId: string, id: string): Promise<void> {
    const { count } = await this.prisma.taxRate.deleteMany({ where: { id, organizationId: orgId } });
    if (count === 0) throw new NotFoundException("Tax rate not found");
  }
}
