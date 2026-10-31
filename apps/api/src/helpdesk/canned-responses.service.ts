import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { CannedResponse } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { ServiceSettingsService } from "../service-core";
import { renderCanned } from "./canned";
import type { CannedResponseDto, UpdateCannedResponseDto } from "./helpdesk.dto";

const MAX_RESPONSES = 500;

/** Shared responses (ownerId null) are visible to all staff; personal ones only to their owner. */
@Injectable()
export class CannedResponsesService {
  constructor(
    private prisma: PrismaService,
    private serviceSettings: ServiceSettingsService,
  ) {}

  list(orgId: string, userId: string): Promise<CannedResponse[]> {
    return this.prisma.cannedResponse.findMany({
      where: { organizationId: orgId, OR: [{ ownerId: null }, { ownerId: userId }] },
      orderBy: { title: "asc" },
    });
  }

  async create(orgId: string, userId: string, dto: CannedResponseDto): Promise<CannedResponse> {
    if ((await this.prisma.cannedResponse.count({ where: { organizationId: orgId } })) >= MAX_RESPONSES) {
      throw new BadRequestException(`A workspace can have at most ${MAX_RESPONSES} canned responses`);
    }
    if (dto.categoryId) await this.assertCategory(orgId, dto.categoryId);
    return this.prisma.cannedResponse.create({
      data: {
        organizationId: orgId,
        title: dto.title.trim(),
        body: dto.body,
        categoryId: dto.categoryId ?? null,
        ownerId: dto.personal ? userId : null,
      },
    });
  }

  async update(orgId: string, userId: string, id: string, dto: UpdateCannedResponseDto): Promise<CannedResponse> {
    await this.getVisible(orgId, userId, id);
    if (dto.categoryId) await this.assertCategory(orgId, dto.categoryId);
    return this.prisma.cannedResponse.update({
      where: { id },
      data: {
        title: dto.title?.trim(),
        body: dto.body,
        categoryId: dto.categoryId,
        ownerId: dto.personal === undefined ? undefined : dto.personal ? userId : null,
      },
    });
  }

  async remove(orgId: string, userId: string, id: string): Promise<void> {
    await this.getVisible(orgId, userId, id);
    await this.prisma.cannedResponse.delete({ where: { id } });
  }

  /** The response's body with {{variables}} filled in for one ticket and the current agent. */
  async render(orgId: string, userId: string, id: string, ticketId: string): Promise<{ body: string }> {
    const response = await this.getVisible(orgId, userId, id);
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, organizationId: orgId },
      select: { number: true, subject: true, status: true, requesterName: true, company: { select: { name: true } } },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    const [settings, agent, org] = await Promise.all([
      this.serviceSettings.get(orgId),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    ]);
    return {
      body: renderCanned(response.body, {
        ticket,
        prefix: settings.ticketPrefix,
        requesterName: ticket.requesterName,
        companyName: ticket.company?.name ?? null,
        agentName: agent?.name ?? null,
        workspaceName: org?.name ?? "",
      }),
    };
  }

  private async getVisible(orgId: string, userId: string, id: string): Promise<CannedResponse> {
    const response = await this.prisma.cannedResponse.findFirst({
      where: { id, organizationId: orgId, OR: [{ ownerId: null }, { ownerId: userId }] },
    });
    if (!response) throw new NotFoundException("Canned response not found");
    return response;
  }

  private async assertCategory(orgId: string, id: string): Promise<void> {
    const ok = await this.prisma.ticketCategory.count({ where: { id, organizationId: orgId } });
    if (!ok) throw new BadRequestException("Unknown category");
  }
}
