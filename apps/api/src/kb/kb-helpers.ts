import { BadRequestException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";

/** The staff member making a change, for audit entries. */
export interface KbActor {
  userId: string;
  email?: string | null;
  context: { ipAddress: string | null; userAgent: string | null };
}

/** `base`, or `base-2`, `base-3`, ... whichever is free first. */
export async function availableSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  if (!(await taken(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 74)}-${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${base.slice(0, 60)}-${Date.now().toString(36)}`;
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Audience ids come from the client; every one must be a company of this workspace. */
export async function assertCompaniesInOrg(prisma: PrismaService, organizationId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const count: number = await prisma.company.count({ where: { organizationId, id: { in: ids } } });
  if (count !== new Set(ids).size) throw new BadRequestException("Unknown company in audience");
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
