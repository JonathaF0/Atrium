import { test, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import {
  contactIdByEmail,
  createOwner,
  getCsrfTokenFromContext,
  inviteAndAcceptClient,
  signIn,
} from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

interface Announcement {
  id: string;
  status: string;
  incidentState: string | null;
}

/**
 * Announcements and the public status page. One workspace with two portal
 * clients in different companies: everything sent to company A must stay
 * invisible to company B, and to other workspaces.
 */
test.describe("Announcements", () => {
  test.describe.configure({ mode: "serial" });

  let ownerContext: BrowserContext;
  let owner: Page;
  let headers: Record<string, string>;
  let clientAContext: BrowserContext;
  let clientA: Page;
  let clientBContext: BrowserContext;
  let clientB: Page;
  let companyA: string;
  let companyB: string;
  const suffix = Date.now().toString(36);

  async function create(data: Record<string, unknown>): Promise<Announcement> {
    const res = await owner.request.post(`${API}/announcements`, { data, headers });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  async function publish(id: string): Promise<void> {
    const res = await owner.request.post(`${API}/announcements/${id}/publish`, { headers });
    expect(res.ok(), await res.text()).toBe(true);
  }

  async function postUpdate(id: string, data: Record<string, unknown>): Promise<void> {
    const res = await owner.request.post(`${API}/announcements/${id}/updates`, { data, headers });
    expect(res.status(), await res.text()).toBe(201);
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    ({ context: ownerContext, page: owner } = await createOwner(browser, "ann"));
    headers = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };
    const a = await inviteAndAcceptClient(browser, owner, "ann-a");
    const b = await inviteAndAcceptClient(browser, owner, "ann-b");

    for (const [name, assign] of [
      [`Company A ${suffix}`, (id: string) => (companyA = id)],
      [`Company B ${suffix}`, (id: string) => (companyB = id)],
    ] as const) {
      const res = await owner.request.post(`${API}/companies`, { data: { name }, headers });
      expect(res.status(), await res.text()).toBe(201);
      assign((await res.json()).id);
    }
    for (const [email, companyId] of [
      [a.clientEmail, companyA],
      [b.clientEmail, companyB],
    ]) {
      const contactId = await contactIdByEmail(owner, email);
      const res = await owner.request.put(`${API}/contacts/${contactId}`, { data: { companyId }, headers });
      expect(res.ok(), await res.text()).toBe(true);
    }

    ({ context: clientAContext, page: clientA } = await signIn(browser, a.clientEmail, a.password));
    ({ context: clientBContext, page: clientB } = await signIn(browser, b.clientEmail, b.password));
  });

  test.afterAll(async () => {
    await clientAContext?.close();
    await clientBContext?.close();
    await ownerContext?.close();
  });

  test("audience preview counts companies and portal users before sending", async () => {
    const onlyA = await owner.request.post(`${API}/announcements/audience-preview`, {
      data: { audienceType: "companies", companyIds: [companyA] },
      headers,
    });
    expect(await onlyA.json()).toEqual({ companyCount: 1, recipientCount: 1 });

    const all = await owner.request.post(`${API}/announcements/audience-preview`, {
      data: { audienceType: "all" },
      headers,
    });
    expect((await all.json()).recipientCount).toBe(2);
  });

  test("staff create a targeted draft in the editor and see the live count", async () => {
    await owner.goto(`${WEB}/dashboard/announcements/new`);
    await owner.getByLabel("Title").fill(`Editor draft ${suffix}`);
    await owner.getByRole("combobox", { name: "Audience", exact: true }).selectOption("companies");
    await owner.getByRole("checkbox", { name: `Company A ${suffix}` }).check();
    await expect(owner.getByTestId("audience-preview")).toContainText("Reaches 1 company and 1 portal user", {
      timeout: 10_000,
    });
    await owner.getByRole("button", { name: "Create draft" }).click();
    await expect(owner).toHaveURL(/\/dashboard\/announcements\/[^/]+$/, { timeout: 15_000 });
    await expect(owner.getByTestId("announcement-status")).toContainText("Draft");

    await owner.getByRole("button", { name: "Publish now" }).click();
    await owner.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(owner.getByTestId("announcement-status")).toContainText("Published", { timeout: 10_000 });
  });

  test("maintenance for company A reaches client A only", async () => {
    const title = `Maintenance for A ${suffix}`;
    const start = new Date(Date.now() + 2 * 86_400_000);
    const a = await create({
      type: "maintenance",
      title,
      body: "Patching the **sample** servers.",
      windowStart: start.toISOString(),
      windowEnd: new Date(start.getTime() + 3_600_000).toISOString(),
      audienceType: "companies",
      companyIds: [companyA],
    });
    await publish(a.id);

    // Client A: unread badge, banner on the home page, entry in the feed.
    await clientA.goto(`${WEB}/portal/projects`);
    await expect(clientA.getByTestId("announcements-unread-badge")).toBeVisible({ timeout: 15_000 });
    await clientA.goto(`${WEB}/portal`);
    await expect(clientA.getByTestId("announcement-banner").getByText(title)).toBeVisible({ timeout: 15_000 });
    await clientA.goto(`${WEB}/portal/announcements`);
    await expect(clientA.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });

    // Client B: nothing in the banner, the feed or the API, and a direct read is a 404.
    await clientB.goto(`${WEB}/portal`);
    await expect(clientB.getByRole("heading", { name: /welcome back/i })).toBeVisible({ timeout: 15_000 });
    await expect(clientB.getByText(title)).toHaveCount(0);
    await clientB.goto(`${WEB}/portal/announcements`);
    await expect(clientB.getByRole("heading", { name: "Announcements", exact: true })).toBeVisible();
    await expect(clientB.getByText(title)).toHaveCount(0);
    const feed = await clientB.request.get(`${API}/announcements/mine`);
    expect(JSON.stringify(await feed.json())).not.toContain(a.id);
    const banner = await clientB.request.get(`${API}/announcements/mine/banner`);
    expect(JSON.stringify(await banner.json())).not.toContain(a.id);
    const csrfB = await getCsrfTokenFromContext(clientBContext);
    const read = await clientB.request.post(`${API}/announcements/mine/${a.id}/read`, {
      headers: { "x-csrf-token": csrfB },
    });
    expect(read.status()).toBe(404);
  });

  test("incident updates build a timeline and resolved incidents move to history", async () => {
    const title = `Email delays ${suffix}`;
    const a = await create({ type: "incident", severity: "minor", title, body: "Looking into delays." });
    expect(a.incidentState).toBe("investigating");
    await publish(a.id);
    await postUpdate(a.id, { state: "identified", body: "Found a stuck queue." });

    await clientA.goto(`${WEB}/portal/announcements?id=${a.id}`);
    const card = clientA.getByTestId("announcements-active").getByTestId("announcement-card").filter({ hasText: title });
    await expect(card.getByTestId("announcement-timeline")).toContainText("Found a stuck queue.", { timeout: 15_000 });
    await expect(card.getByTestId("announcement-timeline")).toContainText("Identified");

    await postUpdate(a.id, { state: "resolved", body: "Queue drained.", postmortem: "A sample root cause." });
    await clientA.reload();
    const history = clientA.getByTestId("announcements-history").getByTestId("announcement-card").filter({ hasText: title });
    await expect(history).toContainText("Queue drained.", { timeout: 15_000 });
    await expect(history).toContainText("A sample root cause.");
  });

  test("a non-critical incident can be dismissed from the banner", async () => {
    const title = `Minor slowness ${suffix}`;
    const a = await create({ type: "incident", severity: "minor", title, body: "Slower than usual." });
    await publish(a.id);

    await clientA.goto(`${WEB}/portal`);
    const item = clientA.getByTestId("announcement-banner-item").filter({ hasText: title });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByRole("button", { name: `Dismiss ${title}` }).click();
    await expect(item).toHaveCount(0);
    await clientA.reload();
    await expect(clientA.getByRole("heading", { name: /welcome back/i })).toBeVisible({ timeout: 15_000 });
    await expect(clientA.getByTestId("announcement-banner-item").filter({ hasText: title })).toHaveCount(0);
  });

  test("a critical incident cannot be dismissed and stays until resolved", async () => {
    const title = `Critical outage ${suffix}`;
    const a = await create({ type: "incident", severity: "critical", title, body: "Major outage." });
    await publish(a.id);

    const csrfA = await getCsrfTokenFromContext(clientAContext);
    const dismiss = await clientA.request.post(`${API}/announcements/mine/${a.id}/dismiss`, {
      headers: { "x-csrf-token": csrfA },
    });
    expect(dismiss.status()).toBe(400);

    await clientA.goto(`${WEB}/portal`);
    const item = clientA.getByTestId("announcement-banner-item").filter({ hasText: title });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item.getByRole("button", { name: `Dismiss ${title}` })).toHaveCount(0);

    await postUpdate(a.id, { state: "resolved", body: "Restored." });
    await clientA.reload();
    await expect(clientA.getByRole("heading", { name: /welcome back/i })).toBeVisible({ timeout: 15_000 });
    await expect(clientA.getByTestId("announcement-banner-item").filter({ hasText: title })).toHaveCount(0);
  });

  test("public status page is off by default and shows only public items for everyone", async ({ browser }) => {
    const settings = await owner.request.get(`${API}/announcements/settings`);
    const { slug, statusPageEnabled } = (await settings.json()) as { slug: string; statusPageEnabled: boolean };
    expect(statusPageEnabled).toBe(false);

    const anon = await browser.newContext({ storageState: undefined });
    const anonPage = await anon.newPage();
    expect((await anonPage.request.get(`${API}/status/${slug}`)).status()).toBe(404);
    const webOff = await anonPage.goto(`${WEB}/status/${slug}`);
    expect(webOff?.status()).toBe(404);

    // A targeted announcement can never be public.
    const refused = await owner.request.post(`${API}/announcements`, {
      data: { type: "incident", title: "Nope", audienceType: "companies", companyIds: [companyA], publicStatus: true },
      headers,
    });
    expect(refused.status()).toBe(400);

    const publicTitle = `Public incident ${suffix}`;
    const pub = await create({ type: "incident", severity: "major", title: publicTitle, body: "Public body", publicStatus: true });
    await publish(pub.id);

    const toggle = await owner.request.put(`${API}/announcements/settings`, {
      data: { statusPageEnabled: true },
      headers,
    });
    expect(toggle.ok()).toBe(true);

    const res = await anonPage.request.get(`${API}/status/${slug}`);
    expect(res.status()).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).toContain(publicTitle);
    expect(body).not.toContain(`Maintenance for A ${suffix}`);
    expect(body).not.toContain(`Email delays ${suffix}`);

    const rss = await anonPage.request.get(`${API}/status/${slug}/rss`);
    expect(rss.headers()["content-type"]).toContain("application/rss+xml");
    expect(await rss.text()).toContain(publicTitle);

    await anonPage.goto(`${WEB}/status/${slug}`);
    await expect(anonPage.getByText(publicTitle)).toBeVisible({ timeout: 15_000 });
    await expect(anonPage.getByText(`Maintenance for A ${suffix}`)).toHaveCount(0);
    await anon.close();
  });

  test("another workspace cannot read or link this workspace's announcements", async ({ browser }) => {
    const list = await owner.request.get(`${API}/announcements?limit=1`);
    const [first] = ((await list.json()) as { data: { id: string }[] }).data;

    const other = await createOwner(browser, "ann-other");
    const otherHeaders = { "x-csrf-token": await getCsrfTokenFromContext(other.context) };
    expect((await other.page.request.get(`${API}/announcements/${first.id}`)).status()).toBe(404);
    expect(
      (await other.page.request.post(`${API}/announcements/${first.id}/publish`, { headers: otherHeaders })).status(),
    ).toBe(404);
    const otherFeed = await other.page.request.get(`${API}/announcements/mine`);
    expect(JSON.stringify(await otherFeed.json())).not.toContain(first.id);
    await other.context.close();
  });

  test("portal clients cannot use staff endpoints", async () => {
    const csrfA = await getCsrfTokenFromContext(clientAContext);
    expect((await clientA.request.get(`${API}/announcements`)).status()).toBe(403);
    const preview = await clientA.request.post(`${API}/announcements/audience-preview`, {
      data: { audienceType: "all" },
      headers: { "x-csrf-token": csrfA },
    });
    expect(preview.status()).toBe(403);
  });
});
