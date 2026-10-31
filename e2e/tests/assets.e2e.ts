import { test, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { readFileSync } from "fs";
import {
  contactIdByEmail,
  createOwner,
  getCsrfTokenFromContext,
  inviteAndAcceptClient,
  signIn,
} from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/**
 * Assets inventory: staff record assets per client company; portal users see
 * their own company's client-visible assets only.
 */
test.describe("Assets", () => {
  const stamp = Date.now().toString(36);
  const companyAName = `Sample Company A ${stamp}`;
  const companyBName = `Sample Company B ${stamp}`;
  const visibleName = `Office laptop ${stamp}`;
  const hiddenName = `Core switch ${stamp}`;
  const otherName = `Other firewall ${stamp}`;

  let ownerContext: BrowserContext;
  let owner: Page;
  let headers: Record<string, string>;
  let companyA: string;
  let companyB: string;
  let clientA: { email: string; password: string };
  let clientB: { email: string; password: string };
  let otherAssetId: string;

  async function createCompany(name: string): Promise<string> {
    const res = await owner.request.post(`${API}/companies`, { data: { name }, headers });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { id: string }).id;
  }

  async function assignCompany(email: string, companyId: string): Promise<void> {
    const contactId = await contactIdByEmail(owner, email);
    const res = await owner.request.put(`${API}/contacts/${contactId}`, { data: { companyId }, headers });
    expect(res.ok()).toBe(true);
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180000);
    ({ context: ownerContext, page: owner } = await createOwner(browser, "assets"));
    headers = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };
    const a = await inviteAndAcceptClient(browser, owner, "assets-client-a");
    const b = await inviteAndAcceptClient(browser, owner, "assets-client-b");
    clientA = { email: a.clientEmail, password: a.password };
    clientB = { email: b.clientEmail, password: b.password };
    companyA = await createCompany(companyAName);
    companyB = await createCompany(companyBName);
    await assignCompany(clientA.email, companyA);
    await assignCompany(clientB.email, companyB);

    const hidden = await owner.request.post(`${API}/assets`, {
      data: { companyId: companyA, type: "device", name: hiddenName, clientVisible: false },
      headers,
    });
    expect(hidden.status()).toBe(201);
    const other = await owner.request.post(`${API}/assets`, {
      data: { companyId: companyB, type: "device", name: otherName, warrantyEndsAt: "2030-01-31" },
      headers,
    });
    expect(other.status()).toBe(201);
    otherAssetId = ((await other.json()) as { id: string }).id;
  });

  test.afterAll(async () => {
    await ownerContext?.close();
  });

  test("staff adds an asset for a company from the assets page", async () => {
    await owner.goto(`${WEB}/dashboard/assets`);
    await expect(owner.getByRole("heading", { name: "Assets", exact: true })).toBeVisible({ timeout: 15000 });
    await owner.getByRole("button", { name: "Add asset" }).click();
    const form = owner.getByRole("form", { name: "Add asset" });
    await form.getByLabel("Company").selectOption({ label: companyAName });
    await form.getByLabel("Type").selectOption("software_license");
    await form.getByLabel("Name").fill(visibleName);
    await form.getByLabel("Seats").fill("25");
    await form.getByLabel("Renews / expires").fill("2030-06-30");
    await form.getByRole("button", { name: "Add asset" }).click();
    await expect(form).toHaveCount(0);

    await owner.getByRole("searchbox", { name: "Search assets" }).fill(stamp);
    await expect(owner.getByRole("button", { name: visibleName })).toBeVisible({ timeout: 10000 });
    await expect(owner.getByText("(staff only)")).toBeVisible();
  });

  test("the company page lists the company's assets", async () => {
    await owner.goto(`${WEB}/dashboard/contacts/companies/${companyA}`);
    const section = owner.getByRole("region", { name: "Assets" });
    await expect(section.getByText(visibleName)).toBeVisible({ timeout: 15000 });
    await expect(section.getByText(hiddenName)).toBeVisible();
    await expect(section.getByText(otherName)).toHaveCount(0);
  });

  test("a client of company A sees A's visible assets only", async ({ browser }) => {
    const { context, page } = await signIn(browser, clientA.email, clientA.password);
    try {
      await page.goto(`${WEB}/portal/assets`);
      await expect(page.getByRole("heading", { name: "Assets", exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(visibleName)).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(hiddenName)).toHaveCount(0);
      await expect(page.getByText(otherName)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Assets", exact: true })).toBeVisible();

      const res = await page.request.get(`${API}/assets/mine`);
      const names = ((await res.json()) as { name: string }[]).map((a) => a.name);
      expect(names).toEqual([visibleName]);
      // Staff routes stay closed to clients.
      expect((await page.request.get(`${API}/assets`)).status()).toBe(403);
      expect((await page.request.get(`${API}/assets/${otherAssetId}`)).status()).toBe(403);
    } finally {
      await context.close();
    }
  });

  test("a client of company B does not see company A's assets", async ({ browser }) => {
    const { context, page } = await signIn(browser, clientB.email, clientB.password);
    try {
      await page.goto(`${WEB}/portal/assets`);
      await expect(page.getByText(otherName)).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(visibleName)).toHaveCount(0);
      await expect(page.getByText(hiddenName)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("another workspace cannot read these assets", async ({ browser }) => {
    const { context, page } = await createOwner(browser, "assets-other");
    try {
      expect((await page.request.get(`${API}/assets/${otherAssetId}`)).status()).toBe(404);
      const list = await page.request.get(`${API}/assets?q=${stamp}`);
      expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test("staff export assets as CSV", async () => {
    await owner.goto(`${WEB}/dashboard/assets`);
    await expect(owner.getByRole("heading", { name: "Assets", exact: true })).toBeVisible({ timeout: 15000 });
    const downloadPromise = owner.waitForEvent("download");
    await owner.getByRole("button", { name: "Export CSV" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("assets.csv");
    const path = await download.path();
    const csv = readFileSync(path as string, "utf-8");
    expect(csv.split("\r\n")[0]).toContain("Company,Type,Name");
    expect(csv).toContain(visibleName);
    expect(csv).toContain(hiddenName);
    expect(csv).toContain(otherName);
  });

  test("a connector sync upserts by external id", async () => {
    const payload = {
      assets: [{ externalId: `rmm-${stamp}`, companyName: companyAName, type: "device", name: `Synced PC ${stamp}` }],
    };
    const first = await owner.request.put(`${API}/assets/sync/sample-rmm`, { data: payload, headers });
    expect(first.ok()).toBe(true);
    expect(await first.json()).toMatchObject({ created: 1, updated: 0 });
    const second = await owner.request.put(`${API}/assets/sync/sample-rmm`, { data: payload, headers });
    expect(await second.json()).toMatchObject({ created: 0, updated: 1 });
  });
});
