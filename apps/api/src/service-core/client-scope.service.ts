import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** Who a portal user is in client terms: their contact, company, and whether they administer it. */
export interface ClientScope {
  userId: string;
  organizationId: string;
  contactId: string | null;
  companyId: string | null;
  companyAdmin: boolean;
  email: string | null;
  name: string | null;
}

@Injectable()
export class ClientScopeService {
  constructor(private prisma: PrismaService) {}

  /**
   * Resolves the session user's client identity. Everything comes from the
   * user's own contact row in this workspace; ids supplied by the client are
   * never used to widen it.
   */
  async resolve(userId: string, organizationId: string): Promise<ClientScope> {
    const contact = await this.prisma.contact.findFirst({
      where: { organizationId, userId },
      select: { id: true, companyId: true, companyAdmin: true, email: true, name: true },
    });
    return {
      userId,
      organizationId,
      contactId: contact?.id ?? null,
      companyId: contact?.companyId ?? null,
      companyAdmin: !!(contact?.companyAdmin && contact.companyId),
      email: contact?.email ?? null,
      name: contact?.name ?? null,
    };
  }
}

/**
 * Prisma `where` fragment for records a client may see: their own, plus their
 * company's when they are a company admin. `userField` names the column that
 * holds the requesting user's id.
 */
export function clientOwnedWhere<U extends string>(
  scope: ClientScope,
  userField: U,
): { OR: Array<Record<string, string>> } {
  const or: Array<Record<string, string>> = [{ [userField]: scope.userId }];
  if (scope.companyAdmin && scope.companyId) or.push({ companyId: scope.companyId });
  return { OR: or };
}

/** True when a client may see a record owned by `ownerUserId` in `companyId`. */
export function clientCanSee(scope: ClientScope, ownerUserId: string | null, companyId: string | null): boolean {
  if (ownerUserId && ownerUserId === scope.userId) return true;
  return scope.companyAdmin && !!scope.companyId && companyId === scope.companyId;
}
