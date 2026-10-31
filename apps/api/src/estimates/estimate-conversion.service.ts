import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { InvoicesService } from "../invoices/invoices.service";
import { ContactSyncService } from "../contact-sync/contact-sync.service";
import { AttachmentStorageService, AuditService, auditContext } from "../service-core";
import type { AuditRequestContext } from "../service-core";
import { EstimatesService } from "./estimates.service";
import { EstimatePdfService } from "./estimate-pdf.service";
import { planInvoices } from "./estimate-math";
import type { ConversionMode, InvoicePlan } from "./estimate-math";
import { sortLines } from "./estimate-serialize";
import type { ConvertEstimateDto } from "./estimates.dto";

const DAY_MS = 86_400_000;

/** Start of the next UTC day: when a converted recurring schedule would first run once activated. */
function nextDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS);
}

export interface ConversionResult {
  estimateId: string;
  projectId: string;
  invoiceIds: string[];
  recurringInvoiceIds: string[];
  documentId: string;
}

@Injectable()
export class EstimateConversionService {
  private readonly logger = new Logger(EstimateConversionService.name);

  constructor(
    private prisma: PrismaService,
    private estimates: EstimatesService,
    private invoices: InvoicesService,
    private pdf: EstimatePdfService,
    private storage: AttachmentStorageService,
    private audit: AuditService,
    private contactSync: ContactSyncService,
  ) {}

  /**
   * Turns an accepted estimate into a project (new or existing), draft invoices,
   * paused recurring schedules and a signed copy in the project's documents,
   * all in one transaction. A second conversion is refused.
   */
  async convert(orgId: string, id: string, userId: string, dto: ConvertEstimateDto, req?: AuditRequestContext): Promise<ConversionResult> {
    const e = await this.estimates.findRaw(orgId, id);
    if (e.status === "converted" || e.convertedAt) throw new ConflictException("This estimate was already converted");
    if (e.status !== "accepted") throw new BadRequestException("Only accepted estimates can be converted");

    const lines = sortLines(e.lineItems).map((l) => ({ ...l, quantity: Number(l.quantity) }));
    let plans: InvoicePlan[];
    try {
      plans = planInvoices(lines, e, dto.invoices as ConversionMode, {
        depositPercent: dto.depositPercent ?? e.depositPercent,
        milestones: dto.milestones,
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    let existingProjectId: string | null = null;
    if (dto.project === "existing") {
      existingProjectId = dto.projectId ?? e.projectId;
      if (!existingProjectId) throw new BadRequestException("Choose the project to use");
      const project = await this.prisma.project.findFirst({
        where: { id: existingProjectId, organizationId: orgId },
        select: { id: true, archivedAt: true },
      });
      if (!project) throw new BadRequestException("Project not found");
      if (project.archivedAt) throw new BadRequestException("The project is archived");
    }

    // Render and store the signed copy first; storage isn't transactional, so it is removed on failure.
    const pdf = await this.pdf.render(e, { withAcceptance: true });
    const filename = `${e.number}${e.version > 1 ? `-v${e.version}` : ""}-signed.pdf`;
    const storageKey = await this.storage.storeBuffer(pdf, orgId, "estimate-documents", filename, "application/pdf");

    const recurringLines = lines.filter((l) => l.billingType === "recurring" && (!l.optional || l.selected));
    const now = new Date();

    let result: ConversionResult;
    try {
      result = await this.prisma.$transaction(
        async (tx) => {
          const claimed = await tx.estimate.updateMany({
            where: { id, organizationId: orgId, status: "accepted", convertedAt: null },
            data: { status: "converted", convertedAt: now },
          });
          if (claimed.count === 0) throw new ConflictException("This estimate was already converted");

          const projectId =
            existingProjectId ??
            (
              await tx.project.create({
                data: {
                  organizationId: orgId,
                  name: (dto.projectName?.trim() || e.title).slice(0, 200),
                  description: `Created from estimate ${e.number}`,
                },
                select: { id: true },
              })
            ).id;

          if (e.recipientUserId) {
            await tx.projectClient.upsert({
              where: { projectId_userId: { projectId, userId: e.recipientUserId } },
              create: { projectId, userId: e.recipientUserId },
              update: {},
            });
          }

          const invoiceIds: string[] = [];
          for (const plan of plans) {
            if (plan.lineItems.length === 0) continue;
            const invoice = await this.invoices.createDraftInTx(tx, orgId, {
              projectId,
              estimateId: id,
              notes: `${plan.label} for estimate ${e.number}: ${e.title}`.slice(0, 2000),
              lineItems: plan.lineItems,
            });
            invoiceIds.push(invoice.id);
          }

          const recurringInvoiceIds = await this.createSchedules(tx, orgId, e, projectId, recurringLines, now);

          const file = await tx.file.create({
            data: {
              filename,
              storageKey,
              mimeType: "application/pdf",
              sizeBytes: pdf.length,
              description: `Signed estimate ${e.number}`,
              projectId,
              organizationId: orgId,
              uploadedById: userId,
            },
          });
          const document = await tx.document.create({
            data: {
              type: "quote",
              title: `Estimate ${e.number}: ${e.title}`.slice(0, 200),
              fileId: file.id,
              projectId,
              organizationId: orgId,
              uploadedById: userId,
              status: "accepted",
              requiresApproval: true,
              sentAt: e.sentAt ?? now,
            },
          });
          if (e.acceptedById) {
            await tx.documentResponse.create({
              data: {
                documentId: document.id,
                userId: e.acceptedById,
                action: "accepted",
                signatureImageKey: e.signatureKey,
                signatureMethod: "draw",
                signedAt: e.respondedAt ?? now,
                reason: null,
              },
            });
          }
          const acceptEvent = await tx.estimateEvent.findFirst({
            where: { estimateId: id, action: "accepted" },
            orderBy: { createdAt: "desc" },
          });
          await tx.documentAuditEvent.createMany({
            data: [
              { documentId: document.id, userId, action: "created", metadata: JSON.stringify({ estimateId: id }) },
              {
                documentId: document.id,
                userId: e.acceptedById,
                action: "accepted",
                ipAddress: acceptEvent?.ipAddress ?? null,
                userAgent: acceptEvent?.userAgent ?? null,
                metadata: JSON.stringify({
                  estimateId: id,
                  number: e.number,
                  version: e.version,
                  acceptedName: e.acceptedName,
                  acceptedAt: (e.respondedAt ?? now).toISOString(),
                }),
                createdAt: e.respondedAt ?? now,
              },
            ],
          });

          await tx.estimate.update({ where: { id }, data: { documentId: document.id, projectId } });
          await tx.estimateEvent.create({
            data: {
              estimateId: id,
              actorId: userId,
              action: "converted",
              detail: `${invoiceIds.length} draft invoice(s), ${recurringInvoiceIds.length} recurring schedule(s)`,
            },
          });
          await this.audit.record(
            {
              organizationId: orgId,
              actorId: userId,
              action: "estimate.converted",
              targetType: "estimate",
              targetId: id,
              summary: `Converted estimate ${e.number} v${e.version}`,
              metadata: { projectId, invoiceIds, recurringInvoiceIds, documentId: document.id, mode: dto.invoices },
              ...auditContext(req),
            },
            tx,
          );
          return { estimateId: id, projectId, invoiceIds, recurringInvoiceIds, documentId: document.id };
        },
        { timeout: 30_000 },
      );
    } catch (err) {
      await this.storage.remove(storageKey);
      throw err;
    }

    if (e.recipientUserId) {
      await this.contactSync
        .linkProjectClients(result.projectId, orgId, [e.recipientUserId])
        .catch((err: unknown) => this.logger.warn(`Failed to link project contact: ${String(err)}`));
    }
    return result;
  }

  /** One paused recurring schedule per billing interval; staff review and activate it. */
  private async createSchedules(
    tx: Prisma.TransactionClient,
    orgId: string,
    e: { title: string; number: string; companyId: string | null; recipientUserId: string | null },
    projectId: string,
    lines: Array<{ name: string; unit: string; quantity: number; unitPriceCents: number; taxable: boolean; taxRateBps: number; recurringInterval: string | null }>,
    now: Date,
  ): Promise<string[]> {
    const byInterval = new Map<string, typeof lines>();
    for (const l of lines) {
      const interval = l.recurringInterval || "monthly";
      byInterval.set(interval, [...(byInterval.get(interval) ?? []), l]);
    }
    const ids: string[] = [];
    const start = nextDay(now);
    for (const [interval, items] of byInterval) {
      const schedule = await tx.recurringInvoice.create({
        data: {
          organizationId: orgId,
          name: `${e.title} (${interval})`.slice(0, 200),
          companyId: e.companyId,
          recipientUserId: e.recipientUserId,
          projectId,
          interval,
          startDate: start,
          nextRunAt: start,
          status: "paused",
          notes: `From estimate ${e.number}`,
          items: {
            create: items.map((l, order) => {
              const whole = Number.isInteger(l.quantity);
              return {
                description: whole ? l.name : `${l.name} (${l.quantity} ${l.unit})`,
                quantity: whole ? l.quantity : 1,
                unitPrice: whole ? l.unitPriceCents : Math.round(l.quantity * l.unitPriceCents),
                taxRateBps: l.taxable ? l.taxRateBps : 0,
                order,
              };
            }),
          },
        },
      });
      ids.push(schedule.id);
    }
    return ids;
  }
}
