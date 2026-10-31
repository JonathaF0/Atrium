import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}

  async search(orgId: string, q: string) {
    // Portal clients are found as contacts (their contact is linked to their login), so there is
    // no separate clients group.
    const ticketNumber = /^(?:[A-Za-z]{2,10}-)?#?(\d{1,9})$/.exec(q.trim());
    const [projects, tasks, files, contactRows, companies, ticketRows, ticketSettings, kbArticles] = await Promise.all([
      this.prisma.project.findMany({
        where: {
          organizationId: orgId,
          archivedAt: null,
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
        },
        take: 5,
      }),
      this.prisma.task.findMany({
        where: {
          organizationId: orgId,
          // Descriptions have no trigram index; searching them for 1-2 char queries scans every task.
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            ...(q.length >= 3 ? [{ description: { contains: q, mode: "insensitive" as const } }] : []),
          ],
        },
        select: {
          id: true,
          title: true,
          description: true,
          projectId: true,
          project: { select: { id: true, name: true } },
        },
        take: 5,
      }),
      this.prisma.file.findMany({
        where: {
          organizationId: orgId,
          filename: { contains: q, mode: "insensitive" },
        },
        select: {
          id: true,
          filename: true,
          projectId: true,
          project: { select: { id: true, name: true } },
        },
        take: 5,
      }),
      this.prisma.contact.findMany({
        where: {
          organizationId: orgId,
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { company: { name: { contains: q, mode: "insensitive" } } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          company: { select: { name: true } },
        },
        take: 5,
      }),
      this.prisma.company.findMany({
        where: {
          organizationId: orgId,
          name: { contains: q, mode: "insensitive" },
        },
        select: { id: true, name: true },
        take: 5,
      }),
      this.prisma.ticket.findMany({
        where: {
          organizationId: orgId,
          OR: [
            { subject: { contains: q, mode: "insensitive" } },
            ...(ticketNumber ? [{ number: Number(ticketNumber[1]) }] : []),
          ],
        },
        select: { id: true, number: true, subject: true, status: true },
        orderBy: { lastActivityAt: "desc" },
        take: 5,
      }),
      this.prisma.serviceSettings.findUnique({ where: { organizationId: orgId }, select: { ticketPrefix: true } }),
      this.prisma.kbArticle.findMany({
        where: {
          organizationId: orgId,
          status: { not: "archived" },
          title: { contains: q, mode: "insensitive" },
        },
        select: { id: true, title: true, status: true },
        orderBy: { updatedAt: "desc" },
        take: 5,
      }),
    ]);

    const contacts = contactRows.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      company: c.company?.name ?? null,
    }));

    const tickets = ticketRows.map((t) => ({ ...t, reference: `${ticketSettings?.ticketPrefix ?? "TKT"}-${t.number}` }));

    return { projects, tasks, files, contacts, companies, tickets, kbArticles };
  }
}
