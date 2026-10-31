import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { formatMoney } from "@atrium/shared";
import { getCurrency } from "../common/helpers/currency";
import { PrismaService } from "../prisma/prisma.service";
import PDFDocument from "pdfkit";
import { PassThrough } from "stream";
import { calculateInvoiceTax } from "../payments/invoice-total";
import {
  drawAmountLine,
  drawDocumentHeader,
  drawItemRow,
  drawItemTableHeader,
  drawMetaRow,
  drawRule,
  ensureSpace,
  formatTaxRate,
  loadPdfBranding,
} from "./pdf-layout";

@Injectable()
export class InvoicePdfService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async generate(invoiceId: string, orgId: string): Promise<{ stream: PassThrough; filename: string }> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId: orgId },
      include: {
        lineItems: true,
        project: { select: { name: true } },
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");

    const brand = await loadPdfBranding(this.prisma, orgId);

    const currency: string = getCurrency(this.config);
    const money = (cents: number): string => formatMoney(cents, currency);
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = new PassThrough();
    doc.pipe(stream);

    drawDocumentHeader(doc, brand, "INVOICE", invoice.invoiceNumber);

    // Meta info
    const metaY = 110;
    const meta = [
      { label: "Date", value: new Date(invoice.createdAt).toLocaleDateString(), x: 50 },
      { label: "Status", value: invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1), x: 150 },
    ];
    if (invoice.dueDate) meta.push({ label: "Due Date", value: new Date(invoice.dueDate).toLocaleDateString(), x: 250 });
    if (invoice.project) meta.push({ label: "Project", value: invoice.project.name, x: 370 });
    drawMetaRow(doc, metaY, meta);

    const tableStart = metaY + 50;
    drawRule(doc, tableStart);
    let y = drawItemTableHeader(doc, tableStart + 10);

    let subtotal = 0;
    for (const item of invoice.lineItems) {
      y = ensureSpace(doc, y, 20);
      const lineTotal = item.quantity * item.unitPrice;
      subtotal += lineTotal;
      const rate = item.taxRateBps ? ` (tax ${formatTaxRate(item.taxRateBps)})` : "";
      drawItemRow(doc, y, {
        description: item.description + rate,
        quantity: String(item.quantity),
        unitPrice: money(item.unitPrice),
        total: money(lineTotal),
      });
      y += 20;
    }

    const tax = calculateInvoiceTax(invoice.lineItems);
    drawRule(doc, y + 5, 350);
    y += 15;
    if (tax > 0) {
      drawAmountLine(doc, y, "Subtotal", money(subtotal));
      y += 16;
      drawAmountLine(doc, y, "Tax", money(tax));
      y += 18;
    }
    drawAmountLine(doc, y, "Total", money(subtotal + tax), true);

    // Notes
    if (invoice.notes) {
      y += 40;
      doc.fontSize(9).fillColor("#6b7280").text("Notes", 50, y);
      y += 14;
      doc.fontSize(10).fillColor("#374151").text(invoice.notes, 50, y, { width: 495 });
    }

    doc.end();

    const filename = `${invoice.invoiceNumber}.pdf`;
    return { stream, filename };
  }
}
