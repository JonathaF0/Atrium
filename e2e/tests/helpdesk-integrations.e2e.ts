import { test, expect } from "@playwright/test";
import { getCsrfTokenFromContext } from "./helpers";
import { API, WEB, createArticle, createTwoCompanyWorkspace } from "./kb-helpers";
import type { TwoCompanyWorkspace } from "./kb-helpers";

/**
 * How the helpdesk ties into the other modules: help article suggestions and
 * the incident banner on the client's ticket form, the asset picker, the staff
 * ticket page's article, asset, incident, estimate and draft-article actions,
 * and ticket time counted against a contract's covered hours.
 */
test.describe("Helpdesk integrations", () => {
  let ws: TwoCompanyWorkspace;
  let clientHeaders: Record<string, string>;
  let categoryId: string;
  const stamp: string = Date.now().toString(36);

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180000);
    ws = await createTwoCompanyWorkspace(browser, `hdi-${stamp}`);
    clientHeaders = { "x-csrf-token": await getCsrfTokenFromContext(ws.a.context) };
    const categories: { id: string; name: string }[] = await (await ws.a.page.request.get(`${API}/tickets/mine/categories`)).json();
    categoryId = (categories.find((c) => c.name === "Network and internet") ?? categories[0]).id;
  });

  test.afterAll(async () => {
    await ws?.close();
  });

  test("the ticket form suggests articles, shows the incident banner and offers the company's assets", async () => {
    await createArticle(ws.owner, ws.ownerHeaders, { title: `Fix VPN disconnects ${stamp}`, body: "Restart the VPN client." });
    const incident = await ws.owner.request.post(`${API}/announcements`, {
      data: {
        type: "incident",
        severity: "major",
        incidentState: "investigating",
        title: `VPN outage ${stamp}`,
        body: "We are looking into it.",
        audienceType: "all",
        categoryIds: [categoryId],
      },
      headers: ws.ownerHeaders,
    });
    expect(incident.status()).toBe(201);
    const incidentId: string = ((await incident.json()) as { id: string }).id;
    expect((await ws.owner.request.post(`${API}/announcements/${incidentId}/publish`, { headers: ws.ownerHeaders })).ok()).toBe(true);
    const asset = await ws.owner.request.post(`${API}/assets`, {
      data: { companyId: ws.a.companyId, type: "device", name: `Laptop ${stamp}` },
      headers: ws.ownerHeaders,
    });
    expect(asset.status()).toBe(201);

    const page = ws.a.page;
    await page.goto(`${WEB}/portal/tickets/new`);
    await page.getByLabel("Subject").fill("VPN disconnects every hour");
    await expect(page.getByTestId("kb-suggestions").getByText(`Fix VPN disconnects ${stamp}`)).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Category").selectOption(categoryId);
    await expect(page.getByTestId("announcement-banner").getByText(`VPN outage ${stamp}`)).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Affected device or service (optional)").selectOption({ label: `Laptop ${stamp}` });
    await page.getByLabel("Description").fill("Drops every hour.");
    await page.getByRole("button", { name: "Submit request" }).click();
    await page.waitForURL(/\/portal\/tickets\/(?!new$)[^/]+$/, { timeout: 15000 });
    const ticketId = page.url().split("/").pop() as string;

    const linked: { name: string }[] = await (await ws.owner.request.get(`${API}/assets/for-ticket/${ticketId}`)).json();
    expect(linked.map((a) => a.name)).toEqual([`Laptop ${stamp}`]);
  });

  test("the other company's assets are not offered", async () => {
    await ws.owner.request.post(`${API}/assets`, {
      data: { companyId: ws.b.companyId, type: "device", name: `Other laptop ${stamp}` },
      headers: ws.ownerHeaders,
    });
    const mine: { name: string }[] = await (await ws.a.page.request.get(`${API}/assets/mine`)).json();
    expect(mine.map((a) => a.name)).not.toContain(`Other laptop ${stamp}`);
  });

  test("staff link an incident and insert an article from the ticket page", async () => {
    const created = await ws.a.page.request.post(`${API}/tickets/mine`, {
      data: { subject: `Cannot reach file share ${stamp}`, description: "Since this morning", categoryId },
      headers: clientHeaders,
    });
    expect(created.status()).toBe(201);
    const ticketId: string = ((await created.json()) as { id: string }).id;

    const owner = ws.owner;
    await owner.goto(`${WEB}/dashboard/tickets/${ticketId}`);
    const related = owner.getByRole("region", { name: "Related" });
    await related.getByLabel("Incident to link").selectOption({ label: `VPN outage ${stamp}` });
    await related.getByRole("button", { name: "Link" }).last().click();
    await expect(related.getByRole("link", { name: `VPN outage ${stamp}` })).toBeVisible();

    await owner.getByRole("button", { name: "Insert article..." }).click();
    await owner.getByLabel("Search help articles").fill("VPN");
    await owner.getByRole("button", { name: `Fix VPN disconnects ${stamp}` }).click();
    await expect(owner.getByLabel("Message")).toHaveValue(new RegExp(`\\[Fix VPN disconnects ${stamp}\\]\\(.+/portal/kb/`));

    await expect(owner.getByRole("link", { name: "Create estimate" })).toHaveAttribute("href", `/dashboard/estimates/new?ticketId=${ticketId}`);
  });

  test("a resolved ticket can become a draft help article", async () => {
    const created = await ws.a.page.request.post(`${API}/tickets/mine`, {
      data: { subject: `Printer driver missing ${stamp}`, description: "Reinstalling did not help" },
      headers: clientHeaders,
    });
    const ticketId: string = ((await created.json()) as { id: string }).id;
    await ws.owner.request.post(`${API}/tickets/${ticketId}/messages`, {
      data: { body: "Install the driver from the vendor site.", visibility: "public", status: "resolved" },
      headers: ws.ownerHeaders,
    });

    await ws.owner.goto(`${WEB}/dashboard/tickets/${ticketId}`);
    await ws.owner.getByRole("button", { name: "Draft help article from this ticket" }).click();
    await ws.owner.waitForURL(/\/dashboard\/kb\/articles\/[^/]+$/, { timeout: 15000 });
    await expect(ws.owner.getByLabel("Title", { exact: true })).toHaveValue(`Printer driver missing ${stamp}`, { timeout: 15000 });
  });

  test("ticket time counts against the company's contract while covered hours remain", async () => {
    const contract = await ws.owner.request.post(`${API}/contracts`, {
      data: {
        companyId: ws.a.companyId,
        name: `Managed services ${stamp}`,
        type: "retainer",
        startsAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        coveredMinutes: 600,
        coveragePeriod: "monthly",
      },
      headers: ws.ownerHeaders,
    });
    expect(contract.status()).toBe(201);
    const contractId: string = ((await contract.json()) as { id: string }).id;

    const created = await ws.a.page.request.post(`${API}/tickets/mine`, {
      data: { subject: `Slow laptop ${stamp}`, description: "Takes ages to boot" },
      headers: clientHeaders,
    });
    const ticketId: string = ((await created.json()) as { id: string }).id;
    const time = await ws.owner.request.post(`${API}/tickets/${ticketId}/time`, { data: { minutes: 30 }, headers: ws.ownerHeaders });
    expect(time.status()).toBe(201);
    expect(((await time.json()) as { billable: boolean }).billable).toBe(false);

    const usage: { usedMinutes: number } = await (await ws.owner.request.get(`${API}/contracts/${contractId}/usage`)).json();
    expect(usage.usedMinutes).toBe(30);
  });
});
