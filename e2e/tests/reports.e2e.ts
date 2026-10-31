import { readFileSync } from "fs";
import { test, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { createOwner, getCsrfTokenFromContext, inviteAndAcceptClient, signIn } from "./helpers";

const API = "http://localhost:3001/api";
const WEB_URL = "http://localhost:3000";

const REPORTS = [
  { path: "tickets", heading: "Ticket volume", empty: "No tickets in this period." },
  { path: "sla", heading: "SLA compliance", empty: "No tickets were created in this period." },
  { path: "response-times", heading: "Response and resolution times", empty: "No tickets were created in this period." },
  { path: "csat", heading: "Customer satisfaction", empty: "No ratings in this period." },
];

test.describe("Reports", () => {
  test.describe.configure({ mode: "serial" });

  let ownerContext: BrowserContext;
  let owner: Page;
  const companyName = `Sample Reports Co ${Date.now().toString(36)}`;

  test.beforeAll(async ({ browser }) => {
    ({ context: ownerContext, page: owner } = await createOwner(browser, "reports"));
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };

    const contactRes = await owner.request.post(`${API}/contacts`, {
      data: { name: "Sample Client", email: `reports-${Date.now()}@example.com`, companyName },
      headers,
    });
    expect(contactRes.ok(), await contactRes.text()).toBeTruthy();
    const contact: { id: string } = await contactRes.json();

    const projectRes = await owner.request.post(`${API}/projects`, { data: { name: "Managed services" }, headers });
    expect(projectRes.ok(), await projectRes.text()).toBeTruthy();
    const project: { id: string } = await projectRes.json();

    const linkRes = await owner.request.post(`${API}/contacts/${contact.id}/projects/${project.id}`, { headers });
    expect(linkRes.ok(), await linkRes.text()).toBeTruthy();

    // Two billable hours earlier today.
    const end = new Date(Date.now() - 60_000);
    const start = new Date(end.getTime() - 2 * 3600_000);
    const timeRes = await owner.request.post(`${API}/time-entries`, {
      data: { projectId: project.id, startedAt: start.toISOString(), endedAt: end.toISOString(), billable: true },
      headers,
    });
    expect(timeRes.ok(), await timeRes.text()).toBeTruthy();

    // A $300.00 invoice, sent, ten days past due.
    const due = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const invRes = await owner.request.post(`${API}/invoices`, {
      data: { projectId: project.id, dueDate: due, lineItems: [{ description: "Support", quantity: 2, unitPrice: 15000 }] },
      headers,
    });
    expect(invRes.ok(), await invRes.text()).toBeTruthy();
    const invoice: { id: string } = await invRes.json();
    const sendRes = await owner.request.put(`${API}/invoices/${invoice.id}`, { data: { status: "sent" }, headers });
    expect(sendRes.ok(), await sendRes.text()).toBeTruthy();
  });

  test.afterAll(async () => {
    await ownerContext?.close();
  });

  test("landing page links to every report", async () => {
    await owner.goto(`${WEB_URL}/dashboard/reports`);
    await expect(owner.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    const cards = owner.getByTestId("report-cards");
    for (const name of ["Time", "Ticket volume", "SLA compliance", "Response times", "Satisfaction", "Hours by client", "Revenue and aging"]) {
      await expect(cards.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await cards.getByRole("link", { name: /^Hours by client/ }).click();
    await expect(owner).toHaveURL(/\/dashboard\/reports\/hours$/);
  });

  test("sidebar Reports entry opens the landing page", async () => {
    await owner.goto(`${WEB_URL}/dashboard`);
    await owner.getByRole("link", { name: "Reports", exact: true }).first().click();
    await expect(owner).toHaveURL(/\/dashboard\/reports$/);
  });

  test("helpdesk reports render empty states in a new workspace", async () => {
    for (const r of REPORTS) {
      await owner.goto(`${WEB_URL}/dashboard/reports/${r.path}`);
      await expect(owner.getByRole("heading", { name: r.heading })).toBeVisible();
      await expect(owner.getByText(r.empty)).toBeVisible({ timeout: 15000 });
    }
  });

  test("hours report shows the client's billable time", async () => {
    await owner.goto(`${WEB_URL}/dashboard/reports/hours`);
    await expect(owner.getByRole("heading", { name: "Hours by client" })).toBeVisible();
    const row = owner.getByRole("row").filter({ hasText: companyName });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.getByRole("cell", { name: "2.00" }).first()).toBeVisible();
  });

  test("revenue report shows the invoice as outstanding and aged", async () => {
    await owner.goto(`${WEB_URL}/dashboard/reports/revenue`);
    await expect(owner.getByRole("heading", { name: "Revenue and aging" })).toBeVisible();
    const row = owner.getByRole("row").filter({ hasText: companyName });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toContainText("300.00");
    const api = await owner.request.get(`${API}/reports/revenue`);
    expect(api.ok()).toBeTruthy();
    const body: { totals: { invoicedCents: number; outstandingCents: number }; aging: { totals: { d1_30: number } } } =
      await api.json();
    expect(body.totals.invoicedCents).toBe(30000);
    expect(body.totals.outstandingCents).toBe(30000);
    expect(body.aging.totals.d1_30).toBe(30000);
  });

  test("company filter narrows the report", async () => {
    await owner.goto(`${WEB_URL}/dashboard/reports/hours`);
    await expect(owner.getByRole("row").filter({ hasText: companyName })).toBeVisible({ timeout: 15000 });
    await owner.getByLabel("Company", { exact: true }).selectOption({ label: companyName });
    await expect(owner.getByRole("row").filter({ hasText: "No company" })).toHaveCount(0);
    await expect(owner.getByRole("row").filter({ hasText: companyName })).toBeVisible();
  });

  test("CSV export downloads the hours report", async () => {
    await owner.goto(`${WEB_URL}/dashboard/reports/hours`);
    await expect(owner.getByRole("row").filter({ hasText: companyName })).toBeVisible({ timeout: 15000 });
    const downloadPromise = owner.waitForEvent("download");
    await owner.getByRole("button", { name: /export csv/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^hours-report-.*\.csv$/);
    const path = await download.path();
    const content = readFileSync(path, "utf-8");
    expect(content.split("\n")[0]).toContain("Company,Total hours,Billable hours");
    expect(content).toContain(companyName);
  });

  test("every report endpoint answers with CSV", async () => {
    for (const name of ["tickets", "sla", "response-times", "csat", "hours", "revenue"]) {
      const res = await owner.request.get(`${API}/reports/${name}/export`);
      expect(res.status(), name).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/csv");
    }
  });

  test("another workspace never sees this data", async ({ browser }) => {
    const { context, page } = await createOwner(browser, "reports-other");
    try {
      const res = await page.request.get(`${API}/reports/hours`);
      expect(res.ok()).toBeTruthy();
      const body: { companies: { companyName: string }[]; totals: { totalSec: number } } = await res.json();
      expect(body.companies.some((c) => c.companyName === companyName)).toBe(false);
      expect(body.totals.totalSec).toBe(0);
      const revenue = await page.request.get(`${API}/reports/revenue`);
      const rev: { totals: { invoicedCents: number } } = await revenue.json();
      expect(rev.totals.invoicedCents).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("a portal client is refused", async ({ browser }) => {
    const { clientEmail, password } = await inviteAndAcceptClient(browser, owner, "reports-client");
    const { context, page } = await signIn(browser, clientEmail, password);
    try {
      for (const name of ["tickets", "revenue", "hours/export"]) {
        const res = await page.request.get(`${API}/reports/${name}`);
        expect(res.status(), name).toBe(403);
      }
      await page.goto(`${WEB_URL}/dashboard/reports/revenue`);
      await expect(page).toHaveURL(/\/portal/);
    } finally {
      await context.close();
    }
  });
});
