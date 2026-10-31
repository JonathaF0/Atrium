import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Ticket } from "@atrium/database";
import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketSource, type TicketStatus } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { TimeEntriesService } from "../time-entries/time-entries.service";
import { AuditService, ServiceSettingsService, auditContext, formatReference } from "../service-core";
import type { AuditRequestContext } from "../service-core";
import { TicketsService, type TicketActor } from "./tickets.service";
import type { BulkTicketsDto, ConvertToProjectDto, ConvertToTaskDto, SplitTicketDto, TicketTimeDto } from "./helpdesk.dto";

export const SUPPORT_PROJECT_PREFIX = "Support";

export function supportProjectName(companyName: string | null): string {
  return companyName ? `${SUPPORT_PROJECT_PREFIX} — ${companyName}`.slice(0, 200) : SUPPORT_PROJECT_PREFIX;
}

/**
 * Multi-ticket and cross-module operations: bulk actions, merge, split, time
 * logging and conversions to projects and tasks.
 *
 * Merging references rather than copies: a merged ticket keeps its own
 * messages, is closed with `mergedIntoId` set, and the target gets an internal
 * note listing what was merged in. Staff and the requester can still open the
 * merged ticket, read-only, from a link on the target.
 */
@Injectable()
export class TicketsOpsService {
  constructor(
    private prisma: PrismaService,
    private tickets: TicketsService,
    private timeEntries: TimeEntriesService,
    private audit: AuditService,
    private serviceSettings: ServiceSettingsService,
  ) {}

  async bulk(orgId: string, actor: TicketActor, dto: BulkTicketsDto, req?: AuditRequestContext) {
    const ids: string[] = [...new Set(dto.ids)];
    const tickets: Ticket[] = await this.prisma.ticket.findMany({ where: { id: { in: ids }, organizationId: orgId } });
    let labelId: string | null = null;
    if (dto.action === "assign" && dto.value && dto.value !== "none" && !(await this.tickets.isStaff(orgId, dto.value))) {
      throw new BadRequestException("Assignee must be an owner or admin of this workspace");
    }
    if (dto.action === "status" && !(TICKET_STATUSES as readonly string[]).includes(dto.value ?? "")) {
      throw new BadRequestException("Invalid status");
    }
    if (dto.action === "priority" && !(TICKET_PRIORITIES as readonly string[]).includes(dto.value ?? "")) {
      throw new BadRequestException("Invalid priority");
    }
    if (dto.action === "add_label") {
      const label = await this.prisma.label.findFirst({ where: { id: dto.value ?? "", organizationId: orgId }, select: { id: true } });
      if (!label) throw new BadRequestException("Unknown label");
      labelId = label.id;
    }
    let updated = 0;
    const failed: string[] = [];
    for (const ticket of tickets) {
      try {
        switch (dto.action) {
          case "assign":
            await this.tickets.changeTicket(ticket, { assigneeId: dto.value && dto.value !== "none" ? dto.value : null }, actor, { notifyRequester: false, skipAutomation: true, via: "bulk" });
            break;
          case "status":
            if (ticket.mergedIntoId) continue;
            await this.tickets.changeTicket(ticket, { status: dto.value as TicketStatus }, actor, { notifyRequester: true, skipAutomation: true, via: "bulk" });
            break;
          case "close":
            await this.tickets.changeTicket(ticket, { status: "closed" }, actor, { notifyRequester: true, skipAutomation: true, via: "bulk" });
            break;
          case "priority":
            await this.tickets.changeTicket(ticket, { priority: dto.value }, actor, { notifyRequester: false, skipAutomation: true, via: "bulk" });
            break;
          case "add_label":
            await this.tickets.addLabel(ticket.id, orgId, actor.userId, labelId as string);
            break;
        }
        updated++;
      } catch {
        failed.push(ticket.id);
      }
    }
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.userId,
      action: `ticket.bulk_${dto.action}`,
      targetType: "ticket",
      summary: `Bulk ${dto.action} on ${updated} ticket(s)`,
      metadata: { ids: tickets.map((t) => t.id), value: dto.value ?? null },
      ...auditContext(req),
    });
    return { updated, failed, notFound: ids.length - tickets.length };
  }

  async merge(targetId: string, orgId: string, actor: TicketActor, sourceIds: string[], req?: AuditRequestContext) {
    const target: Ticket = await this.tickets.getOrThrow(targetId, orgId);
    if (target.mergedIntoId) throw new BadRequestException("Cannot merge into a ticket that was itself merged");
    const ids: string[] = [...new Set(sourceIds)].filter((id) => id !== targetId);
    if (ids.length === 0) throw new BadRequestException("Choose at least one other ticket");
    const sources: Ticket[] = await this.prisma.ticket.findMany({ where: { id: { in: ids }, organizationId: orgId, mergedIntoId: null } });
    if (sources.length !== ids.length) throw new BadRequestException("Some tickets were not found or are already merged");
    const prefix: string = (await this.serviceSettings.get(orgId)).ticketPrefix;
    const targetRef: string = formatReference(prefix, target.number);
    const notified = new Set<string>();
    for (const source of sources) {
      const email: string = source.requesterEmail ?? source.id;
      const notify: boolean = !notified.has(email) && email !== target.requesterEmail;
      notified.add(email);
      const closed: Ticket = await this.tickets.changeTicket(source, { status: "closed" }, actor, {
        notifyRequester: notify,
        skipAutomation: true,
        via: `merged into ${targetRef}`,
        note: `This request was merged into ${targetRef}, where the conversation continues.`,
      });
      await this.prisma.$transaction([
        this.prisma.ticket.update({ where: { id: closed.id }, data: { mergedIntoId: target.id } }),
        this.prisma.ticketEvent.create({ data: { ticketId: source.id, actorId: actor.userId, type: "merged_into", toValue: targetRef } }),
        this.prisma.ticketEvent.create({ data: { ticketId: target.id, actorId: actor.userId, type: "merged_from", toValue: formatReference(prefix, source.number) } }),
      ]);
    }
    const list: string = sources.map((s) => `- ${formatReference(prefix, s.number)}: ${s.subject}`).join("\n");
    await this.prisma.ticketMessage.create({
      data: {
        ticketId: target.id,
        organizationId: orgId,
        authorUserId: actor.userId,
        authorName: actor.name,
        visibility: "internal",
        source: "system",
        body: `Merged into this ticket:\n\n${list}`,
      },
    });
    await this.prisma.ticket.update({ where: { id: target.id }, data: { lastActivityAt: new Date() } });
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.userId,
      action: "ticket.merged",
      targetType: "ticket",
      targetId: target.id,
      summary: `Merged ${sources.length} ticket(s) into ${targetRef}`,
      metadata: { sourceIds: sources.map((s) => s.id) },
      ...auditContext(req),
    });
    return this.tickets.findOne(target.id, orgId);
  }

  async split(id: string, orgId: string, actor: TicketActor, dto: SplitTicketDto, req?: AuditRequestContext) {
    const source: Ticket = await this.tickets.getOrThrow(id, orgId);
    const message = await this.prisma.ticketMessage.findFirst({ where: { id: dto.messageId, ticketId: id } });
    if (!message) throw new BadRequestException("Unknown message");
    const first = await this.prisma.ticketMessage.findFirst({ where: { ticketId: id }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (first?.id === message.id) throw new BadRequestException("The first message cannot be split off");
    const created: Ticket = await this.tickets.createTicket({
      organizationId: orgId,
      subject: dto.subject ?? `${source.subject} (split)`,
      body: message.body,
      source: source.source as TicketSource,
      priority: source.priority,
      categoryId: source.categoryId,
      companyId: source.companyId,
      requesterUserId: source.requesterUserId,
      requesterContactId: source.requesterContactId,
      requesterEmail: source.requesterEmail,
      requesterName: source.requesterName,
      assigneeId: source.assigneeId,
      projectId: source.projectId,
      triage: source.triage,
      author: { userId: message.authorUserId, name: message.authorName, email: message.authorEmail },
      messageSource: message.source,
      acknowledge: false,
    });
    const newFirst = await this.prisma.ticketMessage.findFirst({ where: { ticketId: created.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
    const prefix: string = (await this.serviceSettings.get(orgId)).ticketPrefix;
    const newRef: string = formatReference(prefix, created.number);
    await this.prisma.$transaction([
      // The message moves: its attachments follow it to the new ticket's first message.
      this.prisma.ticketAttachment.updateMany({ where: { messageId: message.id }, data: { ticketId: created.id, messageId: newFirst?.id ?? null } }),
      this.prisma.ticketMessage.delete({ where: { id: message.id } }),
      this.prisma.ticketLink.create({ data: { ticketId: created.id, relatedTicketId: source.id, type: "split_from" } }),
      this.prisma.ticketEvent.create({ data: { ticketId: source.id, actorId: actor.userId, type: "split_to", toValue: newRef } }),
      this.prisma.ticketEvent.create({ data: { ticketId: created.id, actorId: actor.userId, type: "split_from", toValue: formatReference(prefix, source.number) } }),
      this.prisma.ticketMessage.create({
        data: { ticketId: source.id, organizationId: orgId, authorUserId: actor.userId, authorName: actor.name, visibility: "internal", source: "system", body: `A message was split into ${newRef}.` },
      }),
    ]);
    await this.audit.record({
      organizationId: orgId,
      actorId: actor.userId,
      action: "ticket.split",
      targetType: "ticket",
      targetId: source.id,
      summary: `Split a message into ${newRef}`,
      metadata: { newTicketId: created.id, messageId: message.id },
      ...auditContext(req),
    });
    return this.tickets.findOne(created.id, orgId);
  }

  // ─── Time ───

  /**
   * Logs time through TimeEntriesService so the entry is an ordinary project
   * time entry ("invoice from un-invoiced time" picks it up). Time needs a
   * project: the ticket's, or a per-company "Support — <Company>" project
   * created on first use (no clients are added to it). The company's support
   * rate, when set, overrides the project and member rates for billable time.
   */
  async logTime(id: string, orgId: string, userId: string, dto: TicketTimeDto) {
    const ticket: Ticket = await this.tickets.getOrThrow(id, orgId);
    const projectId: string = ticket.projectId ?? (await this.supportProject(orgId, ticket.companyId));
    const end: Date = dto.endedAt ? new Date(dto.endedAt) : new Date();
    if (Number.isNaN(end.getTime())) throw new BadRequestException("Invalid endedAt");
    const start = new Date(end.getTime() - dto.minutes * 60_000);
    const entry = await this.timeEntries.create(userId, orgId, {
      projectId,
      description: dto.description?.trim() || `Ticket #${ticket.number}: ${ticket.subject}`.slice(0, 1000),
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      billable: dto.billable ?? true,
    });
    const company = ticket.companyId
      ? await this.prisma.company.findFirst({ where: { id: ticket.companyId, organizationId: orgId }, select: { hourlyRateCents: true } })
      : null;
    const updated = await this.prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        ticketId: ticket.id,
        ...(company?.hourlyRateCents != null ? { hourlyRateCents: company.hourlyRateCents } : {}),
      },
    });
    await this.prisma.ticketEvent.create({
      data: { ticketId: id, actorId: userId, type: "time_logged", toValue: `${dto.minutes} min`, detail: dto.billable === false ? "non-billable" : "billable" },
    });
    return updated;
  }

  async listTime(id: string, orgId: string) {
    await this.tickets.getOrThrow(id, orgId);
    return this.prisma.timeEntry.findMany({
      where: { ticketId: id, organizationId: orgId },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        description: true,
        startedAt: true,
        endedAt: true,
        durationSec: true,
        billable: true,
        hourlyRateCents: true,
        invoiceLineItemId: true,
        projectId: true,
        user: { select: { id: true, name: true } },
      },
    });
  }

  /** Find-or-create, serialised per workspace and name so two first entries don't make two projects. */
  async supportProject(orgId: string, companyId: string | null): Promise<string> {
    const company = companyId
      ? await this.prisma.company.findFirst({ where: { id: companyId, organizationId: orgId }, select: { name: true } })
      : null;
    const name: string = supportProjectName(company?.name ?? null);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${orgId}:${name}`}))`;
      const existing = await tx.project.findFirst({ where: { organizationId: orgId, name, archivedAt: null }, select: { id: true } });
      if (existing) return existing.id;
      const created = await tx.project.create({
        data: { organizationId: orgId, name, status: "in_progress", description: "Time logged against support tickets." },
        select: { id: true },
      });
      return created.id;
    });
  }

  // ─── Conversions ───

  async toProject(id: string, orgId: string, actor: TicketActor, dto: ConvertToProjectDto) {
    const ticket: Ticket = await this.tickets.getOrThrow(id, orgId);
    const first = await this.prisma.ticketMessage.findFirst({ where: { ticketId: id, visibility: "public" }, orderBy: { createdAt: "asc" }, select: { body: true } });
    const prefix: string = (await this.serviceSettings.get(orgId)).ticketPrefix;
    const ref: string = formatReference(prefix, ticket.number);
    const project = await this.prisma.project.create({
      data: {
        organizationId: orgId,
        name: (dto.name ?? ticket.subject).slice(0, 200),
        description: `${first?.body ?? ""}\n\nCreated from ticket ${ref}.`.trim().slice(0, 10_000),
        status: "not_started",
        ...(ticket.requesterUserId && (await this.prisma.member.count({ where: { organizationId: orgId, userId: ticket.requesterUserId, role: "member" } }))
          ? { clients: { create: [{ userId: ticket.requesterUserId }] } }
          : {}),
      },
      select: { id: true, name: true },
    });
    await this.prisma.$transaction([
      this.prisma.ticket.update({ where: { id }, data: { projectId: project.id } }),
      this.prisma.ticketEvent.create({ data: { ticketId: id, actorId: actor.userId, type: "converted_project", toValue: project.name } }),
    ]);
    return project;
  }

  async toTask(id: string, orgId: string, actor: TicketActor, dto: ConvertToTaskDto) {
    const ticket: Ticket = await this.tickets.getOrThrow(id, orgId);
    const project = await this.tickets.assertProject(orgId, dto.projectId);
    const prefix: string = (await this.serviceSettings.get(orgId)).ticketPrefix;
    const ref: string = formatReference(prefix, ticket.number);
    const maxOrder = await this.prisma.task.aggregate({ where: { projectId: project.id, organizationId: orgId }, _max: { order: true } });
    const task = await this.prisma.task.create({
      data: {
        title: (dto.title ?? ticket.subject).slice(0, 255),
        description: `From ticket ${ref}: /dashboard/tickets/${ticket.id}`,
        status: "open",
        type: "checkbox",
        order: (maxOrder._max.order ?? -1) + 1,
        projectId: project.id,
        organizationId: orgId,
        assigneeId: ticket.assigneeId,
      },
      select: { id: true, title: true, projectId: true },
    });
    await this.prisma.$transaction([
      this.prisma.ticket.update({ where: { id }, data: { taskId: task.id, projectId: ticket.projectId ?? project.id } }),
      this.prisma.ticketEvent.create({ data: { ticketId: id, actorId: actor.userId, type: "converted_task", toValue: task.title } }),
    ]);
    return task;
  }

  /** A task (often a client request) becomes a ticket; the requester is the task's requester. */
  async fromTask(taskId: string, orgId: string, actor: TicketActor) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId },
      include: { requester: { select: { id: true, name: true, email: true } } },
    });
    if (!task) throw new NotFoundException("Task not found");
    const existing = await this.prisma.ticket.findFirst({ where: { organizationId: orgId, taskId }, select: { id: true } });
    if (existing) throw new BadRequestException("This task already has a ticket");
    const contact = task.requester
      ? await this.prisma.contact.findFirst({ where: { organizationId: orgId, userId: task.requester.id }, select: { id: true, companyId: true, name: true } })
      : null;
    const requesterIsMember: boolean =
      !!task.requester && (await this.prisma.member.count({ where: { organizationId: orgId, userId: task.requester.id } })) > 0;
    const ticket: Ticket = await this.tickets.createTicket({
      organizationId: orgId,
      subject: task.title,
      body: task.description || task.title,
      source: "staff",
      companyId: contact?.companyId ?? null,
      requesterUserId: requesterIsMember ? (task.requester?.id ?? null) : null,
      requesterContactId: contact?.id ?? null,
      requesterEmail: task.requester?.email ?? null,
      requesterName: contact?.name ?? task.requester?.name ?? null,
      projectId: task.projectId,
      taskId: task.id,
      author: actor,
      messageSource: "staff",
      acknowledge: false,
    });
    return this.tickets.findOne(ticket.id, orgId);
  }
}
