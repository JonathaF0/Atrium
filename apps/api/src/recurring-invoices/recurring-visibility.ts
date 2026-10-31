import type { PrismaService } from "../prisma/prisma.service";

type Db = Pick<PrismaService, "contact" | "recurringInvoice">;

/**
 * Billing schedules a portal user may see: those addressed to them, plus their
 * company's when they are its company admin. Invoices a schedule generated are
 * visible to the same people, whether or not the invoice has a project.
 */
export async function visibleScheduleIds(db: Db, userId: string, organizationId: string): Promise<string[]> {
  const contact = await db.contact.findFirst({
    where: { organizationId, userId },
    select: { companyId: true, companyAdmin: true },
  });
  const or: Array<Record<string, string>> = [{ recipientUserId: userId }];
  if (contact?.companyAdmin && contact.companyId) or.push({ companyId: contact.companyId });
  const rows = await db.recurringInvoice.findMany({
    where: { organizationId, OR: or },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function canSeeScheduleInvoice(
  db: Db,
  recurringInvoiceId: string | null,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  if (!recurringInvoiceId) return false;
  const ids = await visibleScheduleIds(db, userId, organizationId);
  return ids.includes(recurringInvoiceId);
}
