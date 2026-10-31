import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createOwner, getCsrfTokenFromContext, inviteAndAcceptClient, signIn } from "./helpers";

const API = "http://localhost:3001/api";
const WEB_URL = "http://localhost:3000";

async function clientUserId(owner: Page, email: string): Promise<string> {
  const res = await owner.request.get(`${API}/recurring-invoices/options`);
  expect(res.ok()).toBe(true);
  const body: { clients: { userId: string; email: string }[] } = await res.json();
  const row = body.clients.find((c) => c.email === email);
  if (!row) throw new Error(`Client ${email} missing from schedule options`);
  return row.userId;
}

test.describe("Recurring invoices", () => {
  test("staff creates a schedule, runs it now, and the client sees the invoice and plan", async ({ browser }) => {
    test.setTimeout(120_000);
    const { context: ownerContext, page: owner } = await createOwner(browser, "rec-owner");
    const { clientEmail, password } = await inviteAndAcceptClient(browser, owner, "rec-client");
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };
    const recipientUserId = await clientUserId(owner, clientEmail);
    const planName = `Managed support ${Date.now().toString(36)}`;

    const createRes = await owner.request.post(`${API}/recurring-invoices`, {
      headers,
      data: {
        name: planName,
        recipientUserId,
        interval: "monthly",
        startDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
        autoSend: true,
        items: [{ description: "Helpdesk retainer", quantity: 1, unitPrice: 25_000, taxRateBps: 1000 }],
      },
    });
    expect(createRes.ok()).toBe(true);

    await owner.goto(`${WEB_URL}/dashboard/invoices/recurring`);
    await expect(owner.getByRole("heading", { name: /recurring billing/i })).toBeVisible({ timeout: 15000 });
    await owner.getByRole("button", { name: new RegExp(planName) }).click();
    const details = owner.getByRole("region", { name: "Schedule details" });
    await expect(details.getByText(/upcoming runs/i)).toBeVisible();

    await details.getByRole("button", { name: /run now/i }).click();
    await owner.getByRole("button", { name: /generate invoice/i }).click();
    await expect(details.getByText(/^INV-\d+/)).toBeVisible({ timeout: 15000 });
    const invoiceNumber = (await details.getByText(/^INV-\d+/).first().textContent())?.trim() ?? "";
    expect(invoiceNumber).toMatch(/^INV-\d+$/);

    const { context: clientContext, page: client } = await signIn(browser, clientEmail, password);
    await client.goto(`${WEB_URL}/portal/billing`);
    await expect(client.getByRole("heading", { name: /your plans/i })).toBeVisible({ timeout: 15000 });
    await expect(client.getByText(planName)).toBeVisible();
    await expect(client.getByText(invoiceNumber)).toBeVisible();

    // The invoice detail is reachable through the client API too, though it has no project.
    const list = await client.request.get(`${API}/invoices/mine`);
    const body: { data: { invoiceNumber: string; status: string }[] } = await list.json();
    expect(body.data.find((i) => i.invoiceNumber === invoiceNumber)?.status).toBe("sent");

    await clientContext.close();
    await ownerContext.close();
  });

  test("a client cannot manage schedules and another client or workspace cannot see them", async ({ browser }) => {
    test.setTimeout(120_000);
    const { context: ownerContext, page: owner } = await createOwner(browser, "rec-iso-owner");
    const a = await inviteAndAcceptClient(browser, owner, "rec-iso-a");
    const b = await inviteAndAcceptClient(browser, owner, "rec-iso-b");
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };
    const recipientUserId = await clientUserId(owner, a.clientEmail);
    const planName = `Private plan ${Date.now().toString(36)}`;

    const created = await owner.request.post(`${API}/recurring-invoices`, {
      headers,
      data: {
        name: planName,
        recipientUserId,
        interval: "monthly",
        startDate: new Date().toISOString().slice(0, 10),
        items: [{ description: "Backup service", quantity: 1, unitPrice: 9_900 }],
      },
    });
    expect(created.ok()).toBe(true);
    const schedule: { id: string } = await created.json();
    const run = await owner.request.post(`${API}/recurring-invoices/${schedule.id}/run`, { headers });
    expect(run.ok()).toBe(true);
    const { invoiceNumber } = (await run.json()) as { invoiceNumber: string };

    // Client B sees neither the plan nor its invoice.
    const { context: bContext, page: clientB } = await signIn(browser, b.clientEmail, b.password);
    const plans = await clientB.request.get(`${API}/recurring-invoices/mine`);
    expect(((await plans.json()) as { data: unknown[] }).data).toHaveLength(0);
    const invoices = await clientB.request.get(`${API}/invoices/mine`);
    const invoiceBody: { data: { invoiceNumber: string }[] } = await invoices.json();
    expect(invoiceBody.data.some((i) => i.invoiceNumber === invoiceNumber)).toBe(false);
    // Staff routes are closed to clients.
    expect((await clientB.request.get(`${API}/recurring-invoices`)).status()).toBe(403);
    expect((await clientB.request.get(`${API}/recurring-invoices/${schedule.id}`)).status()).toBe(403);
    await clientB.goto(`${WEB_URL}/portal/billing`);
    await expect(clientB.getByRole("heading", { name: /your plans/i })).toBeVisible({ timeout: 15000 });
    await expect(clientB.getByText(planName)).toHaveCount(0);
    await bContext.close();

    // Another workspace's owner cannot read it either.
    const { context: otherContext, page: other } = await createOwner(browser, "rec-iso-other");
    expect((await other.request.get(`${API}/recurring-invoices/${schedule.id}`)).status()).toBe(404);
    await otherContext.close();
    await ownerContext.close();
  });
});
