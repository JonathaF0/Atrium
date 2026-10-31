import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { AttachmentStorageService, AuditService, ClientScopeService, normalizeMarkdown } from "../service-core";
import type { TempUploadedFile } from "../files/files.service";
import { CreateClientDocDto, UpdateClientDocDto } from "./client-docs.dto";
import { assertNoCredentials } from "./credential-guard";

export interface ClientDocActor {
  userId: string;
  email?: string | null;
  context: { ipAddress: string | null; userAgent: string | null };
}

const ATTACHMENT_SELECT = { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true } as const;

const DOC_SELECT = {
  id: true,
  companyId: true,
  section: true,
  title: true,
  body: true,
  vaultUrl: true,
  clientVisible: true,
  order: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
  attachments: { select: ATTACHMENT_SELECT, orderBy: { createdAt: "asc" as const } },
} as const;

/**
 * Per-company environment documentation (network diagrams, runbooks,
 * vendors, licences). Staff write it; every portal user whose contact belongs
 * to the company can read the docs marked client-visible, since it describes
 * their own environment. Docs never hold secrets: bodies with obvious
 * credentials are rejected, and passwords live behind the vault link.
 */
@Injectable()
export class ClientDocsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private storage: AttachmentStorageService,
    private clientScope: ClientScopeService,
  ) {}

  async list(organizationId: string, companyId: string) {
    await this.assertCompany(organizationId, companyId);
    return this.prisma.clientDoc.findMany({
      where: { organizationId, companyId },
      select: DOC_SELECT,
      orderBy: [{ section: "asc" }, { order: "asc" }, { title: "asc" }],
    });
  }

  async get(organizationId: string, id: string) {
    const doc = await this.prisma.clientDoc.findFirst({ where: { id, organizationId }, select: DOC_SELECT });
    if (!doc) throw new NotFoundException("Document not found");
    return doc;
  }

  async create(organizationId: string, dto: CreateClientDocDto, actor: ClientDocActor) {
    await this.assertCompany(organizationId, dto.companyId);
    const body: string = normalizeMarkdown(dto.body ?? "");
    assertNoCredentials(dto.title, body);
    const doc = await this.prisma.clientDoc.create({
      data: {
        organizationId,
        companyId: dto.companyId,
        section: dto.section ?? "other",
        title: dto.title.trim(),
        body,
        vaultUrl: dto.vaultUrl || null,
        clientVisible: dto.clientVisible ?? true,
        order: dto.order ?? 0,
        updatedById: actor.userId,
      },
      select: DOC_SELECT,
    });
    await this.record(organizationId, actor, "client_doc.created", doc.id, `Created "${doc.title}"`, {
      companyId: doc.companyId,
      clientVisible: doc.clientVisible,
    });
    return doc;
  }

  async update(organizationId: string, id: string, dto: UpdateClientDocDto, actor: ClientDocActor) {
    const existing = await this.prisma.clientDoc.findFirst({ where: { id, organizationId } });
    if (!existing) throw new NotFoundException("Document not found");
    const data: Prisma.ClientDocUpdateInput = { updatedById: actor.userId };
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.body !== undefined) data.body = normalizeMarkdown(dto.body);
    if (dto.section !== undefined) data.section = dto.section;
    if (dto.vaultUrl !== undefined) data.vaultUrl = dto.vaultUrl || null;
    if (dto.clientVisible !== undefined) data.clientVisible = dto.clientVisible;
    if (dto.order !== undefined) data.order = dto.order;
    assertNoCredentials(data.title as string | undefined, data.body as string | undefined);

    const doc = await this.prisma.clientDoc.update({ where: { id }, data, select: DOC_SELECT });
    const changed: string[] = (["title", "body", "section", "vaultUrl", "clientVisible", "order"] as const).filter(
      (k) => dto[k] !== undefined && dto[k] !== existing[k],
    );
    await this.record(organizationId, actor, "client_doc.updated", id, `Updated "${doc.title}"`, {
      companyId: doc.companyId,
      changed,
      ...(dto.clientVisible !== undefined && dto.clientVisible !== existing.clientVisible
        ? { clientVisible: { from: existing.clientVisible, to: dto.clientVisible } }
        : {}),
    });
    return doc;
  }

  async remove(organizationId: string, id: string, actor: ClientDocActor): Promise<{ ok: true }> {
    const existing = await this.prisma.clientDoc.findFirst({
      where: { id, organizationId },
      select: { id: true, title: true, companyId: true, attachments: { select: { storageKey: true } } },
    });
    if (!existing) throw new NotFoundException("Document not found");
    await this.prisma.clientDoc.delete({ where: { id } });
    await Promise.all(existing.attachments.map((a) => this.storage.remove(a.storageKey)));
    await this.record(organizationId, actor, "client_doc.deleted", id, `Deleted "${existing.title}"`, {
      companyId: existing.companyId,
    });
    return { ok: true };
  }

  async addAttachment(organizationId: string, id: string, file: TempUploadedFile, actor: ClientDocActor) {
    const doc = await this.prisma.clientDoc.findFirst({ where: { id, organizationId }, select: { id: true, title: true } });
    if (!doc) throw new NotFoundException("Document not found");
    const stored = await this.storage.store(file, organizationId, "client-docs");
    const row = await this.prisma.clientDocAttachment.create({
      data: { docId: id, organizationId, ...stored, uploadedById: actor.userId },
      select: ATTACHMENT_SELECT,
    });
    await this.record(organizationId, actor, "client_doc.updated", id, `Attached ${row.filename} to "${doc.title}"`, {
      attachmentId: row.id,
    });
    return row;
  }

  async removeAttachment(organizationId: string, docId: string, attachmentId: string, actor: ClientDocActor): Promise<{ ok: true }> {
    const row = await this.prisma.clientDocAttachment.findFirst({
      where: { id: attachmentId, docId, organizationId },
      select: { id: true, storageKey: true, filename: true },
    });
    if (!row) throw new NotFoundException("Attachment not found");
    await this.prisma.clientDocAttachment.delete({ where: { id: row.id } });
    await this.storage.remove(row.storageKey);
    await this.record(organizationId, actor, "client_doc.updated", docId, `Removed ${row.filename}`, { attachmentId });
    return { ok: true };
  }

  /** Staff download of any attachment in the workspace. */
  async staffAttachment(organizationId: string, attachmentId: string) {
    const row = await this.prisma.clientDocAttachment.findFirst({
      where: { id: attachmentId, organizationId },
      select: { storageKey: true, filename: true, mimeType: true },
    });
    if (!row) throw new NotFoundException("Attachment not found");
    return row;
  }

  /** Client-visible docs of the portal user's own company. */
  async listMine(organizationId: string, userId: string) {
    const scope = await this.clientScope.resolve(userId, organizationId);
    if (!scope.companyId) return [];
    const docs = await this.prisma.clientDoc.findMany({
      where: { organizationId, companyId: scope.companyId, clientVisible: true },
      select: DOC_SELECT,
      orderBy: [{ section: "asc" }, { order: "asc" }, { title: "asc" }],
    });
    // Who last edited is staff-internal detail.
    return docs.map(({ updatedById: _updatedById, ...doc }) => doc);
  }

  async mineAttachment(organizationId: string, userId: string, attachmentId: string) {
    const scope = await this.clientScope.resolve(userId, organizationId);
    if (!scope.companyId) throw new NotFoundException("Attachment not found");
    const row = await this.prisma.clientDocAttachment.findFirst({
      where: { id: attachmentId, organizationId, doc: { companyId: scope.companyId, clientVisible: true } },
      select: { storageKey: true, filename: true, mimeType: true },
    });
    if (!row) throw new NotFoundException("Attachment not found");
    return row;
  }

  private async assertCompany(organizationId: string, companyId: string): Promise<void> {
    const company = await this.prisma.company.findFirst({ where: { id: companyId, organizationId }, select: { id: true } });
    if (!company) throw new BadRequestException("Company not found");
  }

  private record(
    organizationId: string,
    actor: ClientDocActor,
    action: string,
    targetId: string,
    summary: string,
    metadata: Prisma.InputJsonValue,
  ): Promise<void> {
    return this.audit.record({
      organizationId,
      actorId: actor.userId,
      actorEmail: actor.email,
      action,
      targetType: "client_doc",
      targetId,
      summary,
      metadata,
      ...actor.context,
    });
  }
}
