import type { PrismaService } from "../prisma/prisma.service";

// Shared drawing helpers for the A4 money documents (invoices, estimates) so they look alike.
// Only basic pdfkit calls are used here; the unit-test pdfkit mock implements exactly these.

type Doc = PDFKit.PDFDocument;

export const PDF_LEFT = 50;
export const PDF_RIGHT = 545;
export const PDF_MUTED = "#6b7280";
export const PDF_TEXT = "#111827";
export const PDF_BORDER = "#e5e7eb";

export interface PdfBranding {
  orgName: string;
  primaryColor: string;
}

export async function loadPdfBranding(prisma: PrismaService, orgId: string): Promise<PdfBranding> {
  const [org, branding] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    prisma.branding.findUnique({ where: { organizationId: orgId }, select: { primaryColor: true } }),
  ]);
  return {
    orgName: org?.name || "Organization",
    primaryColor: branding?.primaryColor || "#2563eb",
  };
}

/** Org name on the left, document label and number on the right. */
export function drawDocumentHeader(doc: Doc, brand: PdfBranding, label: string, reference: string): void {
  doc.fontSize(24).fillColor(brand.primaryColor).text(brand.orgName, PDF_LEFT, 50);
  doc.fontSize(10).fillColor(PDF_MUTED).text(label, 400, 50, { align: "right" });
  doc.fontSize(18).fillColor(PDF_TEXT).text(reference, 400, 65, { align: "right" });
}

/** A row of label/value pairs; `x` positions are absolute. */
export function drawMetaRow(doc: Doc, y: number, fields: Array<{ label: string; value: string; x: number }>): void {
  doc.fontSize(9).fillColor(PDF_MUTED);
  for (const f of fields) doc.text(f.label, f.x, y);
  doc.fontSize(10).fillColor(PDF_TEXT);
  for (const f of fields) doc.text(f.value, f.x, y + 14);
}

export function drawRule(doc: Doc, y: number, from = PDF_LEFT, width = 1): void {
  doc.moveTo(from, y).lineTo(PDF_RIGHT, y).strokeColor(PDF_BORDER).lineWidth(width).stroke();
}

/** Column headings of the line-item table. Returns the y of the first row. */
export function drawItemTableHeader(doc: Doc, y: number): number {
  doc.fontSize(9).fillColor(PDF_MUTED);
  doc.text("Description", PDF_LEFT, y);
  doc.text("Qty", 340, y, { width: 50, align: "right" });
  doc.text("Unit Price", 400, y, { width: 70, align: "right" });
  doc.text("Total", 475, y, { width: 70, align: "right" });
  drawRule(doc, y + 16, PDF_LEFT, 0.5);
  return y + 26;
}

export function drawItemRow(
  doc: Doc,
  y: number,
  row: { description: string; quantity: string; unitPrice: string; total: string },
): void {
  doc.fontSize(10).fillColor(PDF_TEXT);
  doc.text(row.description, PDF_LEFT, y, { width: 280 });
  doc.text(row.quantity, 340, y, { width: 50, align: "right" });
  doc.text(row.unitPrice, 400, y, { width: 70, align: "right" });
  doc.text(row.total, 475, y, { width: 70, align: "right" });
}

/** Starts a new page when fewer than `needed` points are left. Returns the y to draw at. */
export function ensureSpace(doc: Doc, y: number, needed: number): number {
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  if (y + needed > pageBottom) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

/** 825 -> "8.25%" */
export function formatTaxRate(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** A right-aligned amount line in the totals block. */
export function drawAmountLine(doc: Doc, y: number, label: string, value: string, bold = false): void {
  if (bold) doc.fontSize(11).fillColor(PDF_TEXT).font("Helvetica-Bold");
  else doc.fontSize(10).fillColor(PDF_MUTED);
  doc.text(label, 300, y, { width: 170, align: "right" });
  if (!bold) doc.fillColor(PDF_TEXT);
  doc.text(value, 475, y, { width: 70, align: "right" });
  if (bold) doc.font("Helvetica");
}
