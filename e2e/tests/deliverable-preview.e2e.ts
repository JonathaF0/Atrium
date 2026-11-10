import { test, expect } from "@playwright/test";
import { createPortalClientProject } from "./helpers";
import type { PortalClientProject } from "./helpers";

const API = "http://localhost:3001/api";

/** A one-page PDF with a line of text, small enough to build inline. */
function minimalPdf(): Buffer {
  const stream = "BT /F1 18 Tf 40 100 Td (Sample estimate) Tj ET";
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref: number = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A PDF sent for approval previews in the client's review window instead of showing a blank frame. */
test.describe("Deliverable preview", () => {
  let portal: PortalClientProject;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    portal = await createPortalClientProject(browser, "preview", "Preview project");
    const up = await portal.owner.request.post(`${API}/documents`, {
      multipart: {
        projectId: portal.projectId,
        type: "deliverable",
        title: "Estimate C",
        requiresApproval: "true",
        sendNow: "true",
        file: { name: "estimate.pdf", mimeType: "application/pdf", buffer: minimalPdf() },
      },
      headers: portal.ownerHeaders,
    });
    expect(up.ok()).toBe(true);
  });

  test.afterAll(async () => {
    await portal?.close();
  });

  test("the client's review window loads the PDF as a PDF", async () => {
    const client = portal.client;
    const viewed = client.waitForResponse((r) => /\/api\/documents\/[^/]+\/view$/.test(r.url()));
    await client.goto(`http://localhost:3000/portal/projects/${portal.projectId}`);
    await client.getByRole("button", { name: /^review$/i }).first().click();

    const res = await viewed;
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");

    const frame = client.getByTestId("deliverable-review").locator("iframe");
    await expect(frame).toHaveAttribute("src", /^blob:/);
    const type: string = await frame.evaluate(async (el: HTMLIFrameElement) => (await (await fetch(el.src)).blob()).type);
    expect(type).toBe("application/pdf");
  });
});
