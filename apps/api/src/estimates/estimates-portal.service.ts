import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { PaginationQueryDto, paginatedResponse, paginationArgs } from "../common";
import {
  AttachmentStorageService,
  AuditService,
  ClientScopeService,
  auditContext,
  clientOwnedWhere,
} from "../service-core";
import type { AuditRequestContext, ClientScope } from "../service-core";
import { EstimateNotificationsService } from "./estimate-notifications.service";
import { CLIENT_OPEN_STATUSES, CLIENT_VISIBLE_STATUSES, estimateTotals, inList } from "./estimate-math";
import { serializeForClient, sortLines } from "./estimate-serialize";
import type { AcceptEstimateDto, DeclineEstimateDto, EstimateCommentDto, ToggleOptionDto } from "./estimates.dto";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_SIGNATURE_BYTES = 500 * 1024;

/**
 * Decodes the signature pad's `data:image/png;base64,...` value and checks it
 * really is a PNG of sensible size. Throws a 400 otherwise.
 */
export function decodeSignaturePng(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match) throw new BadRequestException("The signature must be a PNG image");
  const buf = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (buf.length < 67 || buf.length > MAX_SIGNATURE_BYTES) {
    throw new BadRequestException("The signature image is empty or too large");
  }
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new BadRequestException("The signature must be a PNG image");
  return buf;
}

export interface ViewerContext {
  userId: string;
  orgId: string;
  /** Staff previewing the portal: reads never count as the client viewing it. */
  preview: boolean;
  req?: AuditRequestContext;
}

@Injectable()
export class EstimatesPortalService {
  constructor(
    private prisma: PrismaService,
    private scopes: ClientScopeService,
    private storage: AttachmentStorageService,
    private audit: AuditService,
    private notifications: EstimateNotificationsService,
  ) {}

  private visibleWhere(scope: ClientScope): Prisma.EstimateWhereInput {
    return {
      organizationId: scope.organizationId,
      status: { in: [...CLIENT_VISIBLE_STATUSES] },
      AND: [clientOwnedWhere(scope, "recipientUserId")],
    };
  }

  async listMine(userId: string, orgId: string, q: PaginationQueryDto) {
    const { page = 1, limit = 20 } = q;
    const scope = await this.scopes.resolve(userId, orgId);
    const where = this.visibleWhere(scope);
    const [rows, total] = await Promise.all([
      this.prisma.estimate.findMany({
        where,
        include: { lineItems: true },
        orderBy: { sentAt: "desc" },
        ...paginationArgs(page, limit),
      }),
      this.prisma.estimate.count({ where }),
    ]);
    const data = rows.map((r) => ({
      id: r.id,
      number: r.number,
      version: r.version,
      status: r.status,
      title: r.title,
      validUntil: r.validUntil,
      sentAt: r.sentAt,
      totals: estimateTotals(sortLines(r.lineItems), r),
    }));
    return paginatedResponse(data, total, page, limit);
  }

  /** Whether the client has any estimate at all (drives the portal nav entry). */
  async countMine(userId: string, orgId: string): Promise<{ count: number }> {
    const scope = await this.scopes.resolve(userId, orgId);
    return { count: await this.prisma.estimate.count({ where: this.visibleWhere(scope) }) };
  }

  private async load(ctx: ViewerContext, id: string) {
    const scope = await this.scopes.resolve(ctx.userId, ctx.orgId);
    const estimate = await this.prisma.estimate.findFirst({
      where: { id, ...this.visibleWhere(scope) },
      include: { lineItems: true },
    });
    if (!estimate) throw new NotFoundException("Estimate not found");
    return { estimate, scope };
  }

  async getMine(ctx: ViewerContext, id: string) {
    let { estimate } = await this.load(ctx, id);
    if (!ctx.preview && estimate.status === "sent") {
      // First view only: the guarded update makes concurrent loads record a single event.
      const now = new Date();
      const { count } = await this.prisma.estimate.updateMany({
        where: { id, status: "sent", viewedAt: null },
        data: { status: "viewed", viewedAt: now },
      });
      if (count > 0) {
        const { ipAddress, userAgent } = auditContext(ctx.req);
        await this.prisma.estimateEvent.create({
          data: { estimateId: id, actorId: ctx.userId, action: "viewed", ipAddress, userAgent },
        });
        estimate = { ...estimate, status: "viewed", viewedAt: now };
      }
    }
    const comments = await this.prisma.estimateComment.findMany({
      where: { estimateId: id },
      orderBy: { createdAt: "asc" },
    });
    const authorIds = [...new Set(comments.map((c) => c.authorId))];
    const authors = authorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } })
      : [];
    const names = new Map(authors.map((a) => [a.id, a.name]));
    const open = inList(CLIENT_OPEN_STATUSES, estimate.status) && !this.isPastValidity(estimate.validUntil);
    return {
      ...serializeForClient(estimate),
      canRespond: open,
      comments: comments.map((c) => ({
        id: c.id,
        content: c.content,
        createdAt: c.createdAt,
        authorName: names.get(c.authorId) ?? null,
        mine: c.authorId === ctx.userId,
      })),
    };
  }

  private isPastValidity(validUntil: Date | null): boolean {
    return !!validUntil && validUntil.getTime() < Date.now();
  }

  /** Loads an estimate the client can still respond to. */
  private async loadOpen(ctx: ViewerContext, id: string) {
    const loaded = await this.load(ctx, id);
    const { estimate } = loaded;
    if (!inList(CLIENT_OPEN_STATUSES, estimate.status)) {
      throw new BadRequestException("This estimate is no longer open for a response");
    }
    if (this.isPastValidity(estimate.validUntil)) {
      throw new BadRequestException("This estimate has expired. Ask for an updated estimate.");
    }
    return loaded;
  }

  private async clientName(scope: ClientScope, userId: string): Promise<string> {
    if (scope.name) return scope.name;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    return user?.name ?? "A client";
  }

  async toggleOption(ctx: ViewerContext, id: string, dto: ToggleOptionDto) {
    const { estimate } = await this.loadOpen(ctx, id);
    const line = estimate.lineItems.find((l) => l.id === dto.lineItemId);
    if (!line || !line.optional) throw new BadRequestException("Only optional items can be changed");
    if (line.selected !== dto.selected) {
      await this.prisma.$transaction([
        this.prisma.estimateLineItem.update({ where: { id: line.id }, data: { selected: dto.selected } }),
        this.prisma.estimateEvent.create({
          data: {
            estimateId: id,
            actorId: ctx.userId,
            action: "option_toggled",
            detail: `${dto.selected ? "Selected" : "Removed"} "${line.name}"`,
          },
        }),
      ]);
    }
    return this.getMine(ctx, id);
  }

  async comment(ctx: ViewerContext, id: string, dto: EstimateCommentDto) {
    const { estimate, scope } = await this.load(ctx, id);
    await this.prisma.estimateComment.create({ data: { estimateId: id, authorId: ctx.userId, content: dto.content.trim() } });
    this.notifications.notifyClientComment(estimate, await this.clientName(scope, ctx.userId));
    return this.getMine(ctx, id);
  }

  async requestChanges(ctx: ViewerContext, id: string, dto: EstimateCommentDto) {
    const { estimate, scope } = await this.loadOpen(ctx, id);
    const content = dto.content.trim();
    await this.transition(ctx, id, "changes_requested", { respondedAt: new Date() }, async (tx) => {
      await tx.estimateComment.create({ data: { estimateId: id, authorId: ctx.userId, content } });
    }, content.slice(0, 500));
    const name = await this.clientName(scope, ctx.userId);
    this.notifications.notifyClientAction(estimate, "changes_requested", name, content);
    return this.getMine(ctx, id);
  }

  async decline(ctx: ViewerContext, id: string, dto: DeclineEstimateDto) {
    const { estimate, scope } = await this.loadOpen(ctx, id);
    const reason = dto.reason?.trim() || null;
    await this.transition(ctx, id, "declined", { respondedAt: new Date(), declineReason: reason }, undefined, reason);
    await this.audit.record({
      organizationId: ctx.orgId,
      actorId: ctx.userId,
      action: "estimate.declined",
      targetType: "estimate",
      targetId: id,
      summary: `Declined estimate ${estimate.number} v${estimate.version}`,
      ...auditContext(ctx.req),
    });
    this.notifications.notifyClientAction(estimate, "declined", await this.clientName(scope, ctx.userId), reason);
    return this.getMine(ctx, id);
  }

  async accept(ctx: ViewerContext, id: string, dto: AcceptEstimateDto) {
    if (!dto.agree) throw new BadRequestException("Confirm that you accept the estimate");
    const fullName = dto.fullName.trim().replace(/\s+/g, " ");
    if (fullName.length < 2) throw new BadRequestException("Type your full name");
    const png = decodeSignaturePng(dto.signature);
    const { estimate, scope } = await this.loadOpen(ctx, id);

    const signatureKey = await this.storage.storeBuffer(png, ctx.orgId, "estimate-signatures", `${estimate.number}-v${estimate.version}.png`, "image/png");
    const { ipAddress, userAgent } = auditContext(ctx.req);
    try {
      await this.transition(
        ctx,
        id,
        "accepted",
        { respondedAt: new Date(), acceptedById: ctx.userId, acceptedName: fullName, signatureKey },
        undefined,
        `Signed as ${fullName}`,
      );
    } catch (err) {
      await this.storage.remove(signatureKey);
      throw err;
    }
    await this.audit.record({
      organizationId: ctx.orgId,
      actorId: ctx.userId,
      action: "estimate.accepted",
      targetType: "estimate",
      targetId: id,
      summary: `Accepted estimate ${estimate.number} v${estimate.version}`,
      metadata: { acceptedName: fullName, totalCents: estimateTotals(estimate.lineItems, estimate).totalCents },
      ipAddress,
      userAgent,
    });
    this.notifications.notifyClientAction(estimate, "accepted", await this.clientName(scope, ctx.userId), null);
    return this.getMine(ctx, id);
  }

  /** Moves an open estimate to `status` only if it is still open, and records the event. */
  private async transition(
    ctx: ViewerContext,
    id: string,
    status: string,
    data: Prisma.EstimateUpdateManyMutationInput,
    extra?: (tx: Prisma.TransactionClient) => Promise<void>,
    detail?: string | null,
  ): Promise<void> {
    const { ipAddress, userAgent } = auditContext(ctx.req);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.estimate.updateMany({
        where: { id, organizationId: ctx.orgId, status: { in: [...CLIENT_OPEN_STATUSES] } },
        data: { ...data, status },
      });
      if (count === 0) throw new ConflictException("This estimate was already answered");
      if (extra) await extra(tx);
      await tx.estimateEvent.create({
        data: { estimateId: id, actorId: ctx.userId, action: status, detail: detail ?? null, ipAddress, userAgent },
      });
    });
  }

  /** For the client PDF: the estimate if this client may see it. */
  async loadForPdf(ctx: ViewerContext, id: string) {
    const { estimate } = await this.load(ctx, id);
    return estimate;
  }
}
