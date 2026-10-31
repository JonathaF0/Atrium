import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import PDFDocument from "pdfkit";
import type { Estimate, EstimateLineItem } from "@atrium/database";
import { formatMoney } from "@atrium/shared";
import { PrismaService } from "../prisma/prisma.service";
import { getCurrency } from "../common/helpers/currency";
import { AttachmentStorageService, markdownToPlainText } from "../service-core";
import {
  PDF_LEFT,
  PDF_MUTED,
  PDF_RIGHT,
  PDF_TEXT,
  drawAmountLine,
  drawDocumentHeader,
  drawItemRow,
  drawItemTableHeader,
  drawMetaRow,
  drawRule,
  ensureSpace,
  formatTaxRate,
  loadPdfBranding,
} from "../invoices/pdf-layout";
import { estimateTotals, recurringByInterval } from "./estimate-math";
import { sortLines } from "./estimate-serialize";

type Doc = PDFKit.PDFDocument;

const INTERVAL_LABELS: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Sent",
  changes_requested: "Changes requested",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  superseded: "Superseded",
  converted: "Accepted",
};

function fmtQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2);
}

function fmtDate(d: Date | null | undefined): string {
  return d ? new Date(d).toLocaleDateString("en-US", { dateStyle: "medium" }) : "";
}

@Injectable()
export class EstimatePdfService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private storage: AttachmentStorageService,
  ) {}

  /**
   * Renders the estimate as an A4 PDF in the invoice layout. With
   * `withAcceptance`, an accepted estimate gets the signature block (used for
   * the signed copy stored on the project).
   */
  async render(
    estimate: Estimate & { lineItems: EstimateLineItem[] },
    opts: { withAcceptance?: boolean } = {},
  ): Promise<Buffer> {
    const orgId = estimate.organizationId;
    const brand = await loadPdfBranding(this.prisma, orgId);
    const [company, recipient, acceptedBy, acceptEvent] = await Promise.all([
      estimate.companyId
        ? this.prisma.company.findFirst({ where: { id: estimate.companyId, organizationId: orgId }, select: { name: true } })
        : null,
      estimate.recipientUserId
        ? this.prisma.user.findUnique({ where: { id: estimate.recipientUserId }, select: { name: true } })
        : null,
      opts.withAcceptance && estimate.acceptedById
        ? this.prisma.user.findUnique({ where: { id: estimate.acceptedById }, select: { email: true } })
        : null,
      opts.withAcceptance
        ? this.prisma.estimateEvent.findFirst({
            where: { estimateId: estimate.id, action: "accepted" },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true, ipAddress: true },
          })
        : null,
    ]);
    const signature =
      opts.withAcceptance && estimate.signatureKey ? await this.readSignature(estimate.signatureKey) : null;

    const currency = getCurrency(this.config);
    const money = (c: number): string => formatMoney(c, currency);
    const lines = sortLines(estimate.lineItems);
    const totals = estimateTotals(lines, estimate);

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    const reference = estimate.version > 1 ? `${estimate.number} v${estimate.version}` : estimate.number;
    drawDocumentHeader(doc, brand, "ESTIMATE", reference);

    const meta = [
      { label: "Date", value: fmtDate(estimate.sentAt ?? estimate.createdAt), x: 50 },
      { label: "Valid until", value: fmtDate(estimate.validUntil) || "—", x: 150 },
      { label: "Status", value: STATUS_LABELS[estimate.status] ?? estimate.status, x: 260 },
    ];
    const clientLabel = [company?.name, recipient?.name].filter(Boolean).join(" · ");
    if (clientLabel) meta.push({ label: "Prepared for", value: clientLabel.slice(0, 60), x: 370 });
    drawMetaRow(doc, 110, meta);

    let y = 160;
    doc.font("Helvetica-Bold").fontSize(14).fillColor(PDF_TEXT).text(estimate.title, PDF_LEFT, y, { width: PDF_RIGHT - PDF_LEFT });
    doc.font("Helvetica");
    y = doc.y + 8;
    if (estimate.introduction) y = this.paragraph(doc, y, null, markdownToPlainText(estimate.introduction));

    // One-time items, grouped by section heading.
    const oneTime = lines.filter((l) => l.billingType !== "recurring");
    if (oneTime.length > 0) {
      y = ensureSpace(doc, y + 6, 60);
      drawRule(doc, y);
      y = drawItemTableHeader(doc, y + 10);
      y = this.itemRows(doc, y, oneTime, money);

      drawRule(doc, y + 5, 300);
      y += 15;
      y = ensureSpace(doc, y, 100);
      drawAmountLine(doc, y, "Subtotal", money(totals.oneTimeSubtotalCents));
      y += 16;
      if (totals.discountCents > 0) {
        const label =
          estimate.discountType === "percent" && estimate.discountValue
            ? `Discount (${formatTaxRate(estimate.discountValue)})`
            : "Discount";
        drawAmountLine(doc, y, label, `-${money(totals.discountCents)}`);
        y += 16;
      }
      if (totals.taxCents > 0) {
        drawAmountLine(doc, y, "Tax", money(totals.taxCents));
        y += 16;
      }
      y += 2;
      drawAmountLine(doc, y, "Total", money(totals.totalCents), true);
      y += 18;
      if (totals.depositCents > 0) {
        drawAmountLine(doc, y, `Deposit due on acceptance (${estimate.depositPercent}%)`, money(totals.depositCents));
        y += 16;
      }
    }

    // Recurring items: one section per billing interval.
    const recurring = lines.filter((l) => l.billingType === "recurring");
    if (recurring.length > 0) {
      const perInterval = recurringByInterval(lines);
      const intervals = [...new Set(recurring.map((l) => l.recurringInterval || "monthly"))];
      for (const interval of intervals) {
        y = ensureSpace(doc, y + 20, 80);
        doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_TEXT).text(`Recurring · ${INTERVAL_LABELS[interval] ?? interval}`, PDF_LEFT, y);
        doc.font("Helvetica");
        y += 18;
        drawRule(doc, y);
        y = drawItemTableHeader(doc, y + 10);
        y = this.itemRows(doc, y, recurring.filter((l) => (l.recurringInterval || "monthly") === interval), money);
        drawRule(doc, y + 5, 300);
        y += 15;
        drawAmountLine(doc, y, `${INTERVAL_LABELS[interval] ?? interval} total (before tax)`, money(perInterval[interval] ?? 0), true);
        y += 18;
      }
    }

    if (estimate.assumptions) y = this.paragraph(doc, y + 16, "Assumptions", markdownToPlainText(estimate.assumptions));
    if (estimate.exclusions) y = this.paragraph(doc, y + 10, "Exclusions", markdownToPlainText(estimate.exclusions));
    if (estimate.terms) y = this.paragraph(doc, y + 10, "Terms", markdownToPlainText(estimate.terms));
    if (estimate.validUntil) {
      y = ensureSpace(doc, y + 12, 20);
      doc.fontSize(9).fillColor(PDF_MUTED).text(`This estimate is valid until ${fmtDate(estimate.validUntil)}.`, PDF_LEFT, y);
      y = doc.y;
    }

    if (opts.withAcceptance && estimate.acceptedName) {
      y = ensureSpace(doc, y + 24, 150);
      drawRule(doc, y);
      y += 10;
      doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_TEXT).text("Acceptance", PDF_LEFT, y);
      doc.font("Helvetica");
      y += 18;
      if (signature) {
        try {
          doc.image(signature, PDF_LEFT, y, { fit: [200, 60] });
        } catch {
          // An unreadable image must not block the document; the typed name below still records the acceptance.
        }
        y += 66;
      }
      doc.fontSize(10).fillColor(PDF_TEXT).text(`Accepted by ${estimate.acceptedName}`, PDF_LEFT, y);
      y = doc.y + 2;
      const details = [
        acceptedBy?.email,
        estimate.respondedAt ? `on ${new Date(estimate.respondedAt).toISOString().replace("T", " ").slice(0, 16)} UTC` : null,
        acceptEvent?.ipAddress ? `from ${acceptEvent.ipAddress}` : null,
      ].filter(Boolean);
      doc.fontSize(9).fillColor(PDF_MUTED).text(details.join(" "), PDF_LEFT, y);
    }

    doc.end();
    return done;
  }

  private itemRows(doc: Doc, y: number, rows: EstimateLineItem[], money: (c: number) => string): number {
    let group: string | null | undefined;
    for (const l of rows) {
      if (l.group !== group) {
        group = l.group;
        if (group) {
          y = ensureSpace(doc, y + 4, 36);
          doc.font("Helvetica-Bold").fontSize(9).fillColor(PDF_MUTED).text(group.toUpperCase(), PDF_LEFT, y);
          doc.font("Helvetica");
          y += 14;
        }
      }
      const qty = Number(l.quantity);
      const excluded = l.optional && !l.selected;
      const tags = [
        l.optional ? (l.selected ? "optional, included" : "optional, not included") : null,
        l.taxable && l.taxRateBps > 0 ? `tax ${formatTaxRate(l.taxRateBps)}` : null,
      ].filter(Boolean);
      const description = tags.length ? `${l.name} (${tags.join("; ")})` : l.name;
      const height = Math.max(20, doc.fontSize(10).heightOfString(description, { width: 280 }) + 6);
      y = ensureSpace(doc, y, height);
      drawItemRow(doc, y, {
        description,
        quantity: fmtQty(qty),
        unitPrice: money(l.unitPriceCents),
        total: excluded ? "—" : money(Math.round(qty * l.unitPriceCents)),
      });
      y += height;
    }
    return y;
  }

  private paragraph(doc: Doc, y: number, title: string | null, text: string): number {
    y = ensureSpace(doc, y, 40);
    if (title) {
      doc.fontSize(9).fillColor(PDF_MUTED).text(title, PDF_LEFT, y);
      y += 14;
    }
    doc.fontSize(10).fillColor("#374151").text(text, PDF_LEFT, y, { width: PDF_RIGHT - PDF_LEFT });
    return doc.y + 4;
  }

  private async readSignature(key: string): Promise<Buffer | null> {
    try {
      const { body } = await this.storage.download(key);
      const parts: Buffer[] = [];
      for await (const chunk of body) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return Buffer.concat(parts);
    } catch {
      return null;
    }
  }
}
