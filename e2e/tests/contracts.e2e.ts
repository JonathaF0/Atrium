import { test, expect } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import {
  contactIdByEmail,
  createOwner,
  getCsrfTokenFromContext,
  inviteAndAcceptClient,
  signIn,
} from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

interface Client {
  email: string;
  password: string;
  userId: string;
}

/**
 * Contracts: staff record a service agreement with covered hours, count time
 * against it, and company admins (only) see it in the portal.
 */
test.describe("Contracts", () => {
  const stamp = Date.now().toString(36);
  const contractName = `Managed support ${stamp}`;
  const otherContractName = `Other agreement ${stamp}`;
  const service = `Patch management ${stamp}`;

  let ownerContext: BrowserContext;
  let owner: Page;
  let headers: Record<string, string>;
  let companyA: string;
  let companyB: string;
  let adminA: Client;
  let memberA: Client;
  let adminB: Client;
  let contractId: string;
  let timeEntryId: string;

  async function createCompany(name: string): Promise<string> {
    const res = await owner.request.post(`${API}/companies`, { data: { name }, headers });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { id: string }).id;
  }

  async function invite(browser: Browser, prefix: string, companyId: string, companyAdmin: boolean): Promise<Client> {
    const { clientEmail, password } = await inviteAndAcceptClient(browser, owner, prefix);
    const contactId = await contactIdByEmail(owner, clientEmail);
    const res = await owner.request.put(`${API}/contacts/${contactId}`, { data: { companyId, companyAdmin }, headers });
    expect(res.ok()).toBe(true);
    const clients = await owner.request.get(`${API}/clients?limit=100`);
    const rows = ((await clients.json()) as { data: { userId: string; user: { email: string } }[] }).data;
    const row = rows.find((m) => m.user.email === clientEmail);
    if (!row) throw new Error(`Client ${clientEmail} not found`);
    return { email: clientEmail, password, userId: row.userId };
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240000);
    ({ context: ownerContext, page: owner } = await createOwner(browser, "contracts"));
    headers = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };
    companyA = await createCompany(`Sample Company A ${stamp}`);
    companyB = await createCompany(`Sample Company B ${stamp}`);
    adminA = await invite(browser, "contracts-admin-a", companyA, true);
    memberA = await invite(browser, "contracts-member-a", companyA, false);
    adminB = await invite(browser, "contracts-admin-b", companyB, true);

    // A project for company A's admin, so time logged on it belongs to company A.
    const project = await owner.request.post(`${API}/projects`, {
      data: { name: `Support ${stamp}`, clientUserIds: [adminA.userId] },
      headers,
    });
    expect(project.ok()).toBe(true);
    const projectId = ((await project.json()) as { id: string }).id;

    const start = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const entry = await owner.request.post(`${API}/time-entries`, {
      data: {
        projectId,
        description: `Server maintenance ${stamp}`,
        startedAt: start.toISOString(),
        endedAt: new Date(start.getTime() + 90 * 60 * 1000).toISOString(),
      },
      headers,
    });
    expect(entry.ok()).toBe(true);
    timeEntryId = ((await entry.json()) as { id: string }).id;

    const startsAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const other = await owner.request.post(`${API}/contracts`, {
      data: { companyId: companyB, name: otherContractName, startsAt: `${startsAt}T00:00:00.000Z` },
      headers,
    });
    expect(other.status()).toBe(201);
  });

  test.afterAll(async () => {
    await ownerContext?.close();
  });

  test("staff create a contract with covered hours", async () => {
    await owner.goto(`${WEB}/dashboard/contracts`);
    await expect(owner.getByRole("heading", { name: "Contracts", exact: true })).toBeVisible({ timeout: 15000 });
    await owner.getByRole("button", { name: "New contract" }).click();
    const form = owner.getByRole("form", { name: "New contract" });
    await form.getByLabel("Name").fill(contractName);
    await form.getByLabel("Company").selectOption({ label: `Sample Company A ${stamp}` });
    await form.getByLabel("Type", { exact: true }).selectOption("block_hours");
    await form.getByLabel("Starts").fill(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    await form.getByLabel("Covered hours").fill("10");
    await form.getByLabel("Included services (one per line)").fill(`${service}\nHelpdesk`);
    await form.getByRole("button", { name: "Create contract" }).click();

    await owner.waitForURL(/\/dashboard\/contracts\/[^/]+$/, { timeout: 15000 });
    contractId = owner.url().split("/").pop() as string;
    await expect(owner.getByRole("heading", { name: contractName })).toBeVisible();
    await expect(owner.getByText("0m used of 10h")).toBeVisible();
  });

  test("staff count time against the contract and see usage", async () => {
    await owner.goto(`${WEB}/dashboard/contracts/${contractId}`);
    await expect(owner.getByText(`Server maintenance ${stamp}`)).toBeVisible({ timeout: 15000 });
    await owner.getByRole("button", { name: "Count against contract" }).click();
    await expect(owner.getByText("1h 30m used of 10h")).toBeVisible({ timeout: 10000 });
    await expect(owner.getByText("8h 30m remaining")).toBeVisible();

    const usage = await owner.request.get(`${API}/contracts/${contractId}/usage`);
    expect(await usage.json()).toMatchObject({ coveredMinutes: 600, usedMinutes: 90, remainingMinutes: 510 });
    const entries = await owner.request.get(`${API}/contracts/${contractId}/time-entries`);
    const rows = (await entries.json()) as { id: string; billable: boolean }[];
    expect(rows).toEqual([expect.objectContaining({ id: timeEntryId, billable: false })]);
  });

  test("time from another company can't be counted against the contract", async () => {
    const others = await owner.request.get(`${API}/contracts?companyId=${companyB}`);
    const other = ((await others.json()) as { data: { id: string }[] }).data[0];
    const res = await owner.request.post(`${API}/contracts/${other.id}/time-entries/${timeEntryId}`, { headers });
    expect(res.status()).toBe(400);
  });

  test("the company admin sees the contract in the portal", async ({ browser }) => {
    const { context, page } = await signIn(browser, adminA.email, adminA.password);
    try {
      await page.goto(`${WEB}/portal/contracts`);
      await expect(page.getByRole("heading", { name: contractName })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(service)).toBeVisible();
      await expect(page.getByText("1h 30m used of 10h")).toBeVisible();
      await expect(page.getByText(otherContractName)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Contracts", exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("a non-admin of the same company does not see contracts", async ({ browser }) => {
    const { context, page } = await signIn(browser, memberA.email, memberA.password);
    try {
      const res = await page.request.get(`${API}/contracts/mine`);
      expect(await res.json()).toEqual([]);
      await page.goto(`${WEB}/portal/contracts`);
      await expect(page.getByText("No active contracts.")).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(contractName)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Contracts", exact: true })).toHaveCount(0);
      expect((await page.request.get(`${API}/contracts/${contractId}`)).status()).toBe(403);
    } finally {
      await context.close();
    }
  });

  test("another company's admin does not see it", async ({ browser }) => {
    const { context, page } = await signIn(browser, adminB.email, adminB.password);
    try {
      const res = await page.request.get(`${API}/contracts/mine`);
      const names = ((await res.json()) as { name: string }[]).map((c) => c.name);
      expect(names).toEqual([otherContractName]);
    } finally {
      await context.close();
    }
  });

  test("another workspace cannot read the contract", async ({ browser }) => {
    const { context, page } = await createOwner(browser, "contracts-other");
    try {
      expect((await page.request.get(`${API}/contracts/${contractId}`)).status()).toBe(404);
    } finally {
      await context.close();
    }
  });
});
