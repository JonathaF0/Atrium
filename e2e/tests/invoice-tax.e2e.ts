import { test, expect } from "@playwright/test";
import { createPortalClientProject } from "./helpers";
import type { PortalClientProject } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/**
 * Tax on invoices: workspace tax rates, the tax picker in the invoice editor,
 * and totals that include tax for staff and the portal client.
 */
test.describe.serial("Invoice tax", () => {
  let portal: PortalClientProject;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    portal = await createPortalClientProject(browser, "invtax", "Invoice Tax E2E");
  });

  test.afterAll(async () => {
    await portal?.close();
  });

  test("owner adds a tax rate in settings", async () => {
    const { owner } = portal;
    await owner.goto(`${WEB}/dashboard/settings/estimates`);
    await owner.getByLabel("Tax rate name").fill("Sales tax");
    await owner.getByLabel("Tax rate percent").fill("8.25");
    await owner.getByRole("button", { name: "Add rate" }).click();
    await expect(owner.getByTestId("tax-rate-row").filter({ hasText: "Sales tax" })).toContainText("8.25%");
    await expect(owner.getByTestId("tax-rate-row").filter({ hasText: "Sales tax" })).toContainText("Default");
  });

  test("the invoice editor offers the tax rate and totals include tax", async () => {
    const { owner, projectId } = portal;
    await owner.goto(`${WEB}/dashboard/projects/${projectId}?tab=invoices`);
    await owner.getByRole("button", { name: /new invoice/i }).click({ timeout: 15000 });
    await owner.getByRole("menuitem", { name: /create new/i }).click();
    await owner.getByPlaceholder("Description").fill("Taxed service");
    await owner.getByPlaceholder("Qty").fill("2");
    await owner.getByPlaceholder("0.00").fill("100");
    await owner.getByLabel("Tax rate").selectOption({ label: "Sales tax (8.25%)" });
    // 200.00 + 8.25% = 216.50
    await expect(owner.getByText("Includes tax $16.50")).toBeVisible();
    await expect(owner.getByText("$216.50").first()).toBeVisible();
    await owner.getByRole("button", { name: "Save as Draft" }).click();
    await expect(owner.getByRole("heading", { name: "New Invoice" })).toBeHidden({ timeout: 10000 });

    const list = await owner.request.get(`${API}/invoices?projectId=${projectId}`);
    const body: { data: Array<{ id: string; lineItems: Array<{ taxRateBps: number }> }> } = await list.json();
    expect(body.data[0].lineItems[0].taxRateBps).toBe(825);
  });

  test("the portal client sees the tax and the tax-inclusive total", async () => {
    const { owner, ownerHeaders, client, projectId } = portal;
    const res = await owner.request.post(`${API}/invoices`, {
      data: { projectId, lineItems: [{ description: "Portal taxed item", quantity: 1, unitPrice: 10000, taxRateBps: 1000 }] },
      headers: ownerHeaders,
    });
    expect(res.status()).toBe(201);
    const invoice: { id: string; invoiceNumber: string } = await res.json();
    const sent = await owner.request.put(`${API}/invoices/${invoice.id}`, { data: { status: "sent" }, headers: ownerHeaders });
    expect(sent.ok()).toBe(true);

    const stats = await owner.request.get(`${API}/invoices/stats?projectId=${projectId}`);
    expect(((await stats.json()) as { outstandingAmount: number }).outstandingAmount).toBe(11000);

    await client.goto(`${WEB}/portal/projects/${projectId}?tab=invoices`);
    await client.getByText(invoice.invoiceNumber, { exact: true }).click({ timeout: 15000 });
    await expect(client.getByRole("cell", { name: "Tax", exact: true })).toBeVisible();
    await expect(client.getByRole("cell", { name: "$110.00" }).first()).toBeVisible();
  });

  test("tax rates are staff only and validated", async () => {
    const { client, owner, ownerHeaders } = portal;
    expect((await client.request.get(`${API}/tax-rates`)).status()).toBe(403);
    const bad = await owner.request.post(`${API}/tax-rates`, { data: { name: "Too much", rateBps: 20000 }, headers: ownerHeaders });
    expect(bad.status()).toBe(400);
    const badLine = await owner.request.post(`${API}/invoices`, {
      data: { lineItems: [{ description: "x", quantity: 1, unitPrice: 100, taxRateBps: -5 }] },
      headers: ownerHeaders,
    });
    expect(badLine.status()).toBe(400);
  });
});
