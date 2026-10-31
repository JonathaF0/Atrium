import { test, expect } from "@playwright/test";
import { createOwner, getCsrfTokenFromContext } from "./helpers";
import { API, WEB, createArticle, createTwoCompanyWorkspace } from "./kb-helpers";
import type { TwoCompanyWorkspace } from "./kb-helpers";

/**
 * Knowledge base: staff authoring and publishing, the portal help center,
 * and the visibility rules (draft, internal, company-restricted, and other
 * workspaces never leak).
 */
test.describe("Knowledge base", () => {
  test.describe.configure({ mode: "serial" });

  let ws: TwoCompanyWorkspace;
  const stamp: string = Date.now().toString(36);
  const collectionName = `Getting started ${stamp}`;
  const articleTitle = `Connect to the office Wi-Fi ${stamp}`;
  let articleId: string;
  let articleSlug: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180000);
    ws = await createTwoCompanyWorkspace(browser, `kb-${stamp}`);
  });

  test.afterAll(async () => {
    await ws?.close();
  });

  test("staff create a collection and an article, then publish it", async () => {
    const { owner } = ws;
    await owner.goto(`${WEB}/dashboard/kb`);
    await expect(owner.getByRole("heading", { name: "Knowledge base" })).toBeVisible({ timeout: 15000 });

    await owner.getByRole("tab", { name: "Collections" }).click();
    await owner.getByRole("button", { name: "New collection" }).click();
    await owner.getByLabel("Name").fill(collectionName);
    await owner.getByRole("button", { name: "Save collection" }).click();
    await expect(owner.getByText(collectionName)).toBeVisible();

    await owner.getByRole("button", { name: "New article" }).click();
    await owner.waitForURL(/\/dashboard\/kb\/articles\//, { timeout: 15000 });
    articleId = owner.url().split("/").pop()!.split("?")[0];

    await owner.getByLabel("Title").fill(articleTitle);
    await owner.getByLabel("Article body (markdown)").fill("## Steps\n\nOpen **Settings** and choose the office network.");
    await owner.getByLabel("Collection").selectOption({ label: collectionName });
    await expect(owner.getByTestId("kb-preview").getByRole("heading", { name: "Steps" })).toBeVisible();
    await owner.getByRole("button", { name: "Save", exact: true }).click();
    await expect(owner.getByText("Article saved")).toBeVisible();

    await owner.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(owner.getByTestId("kb-status")).toHaveText("Published", { timeout: 10000 });

    const res = await owner.request.get(`${API}/kb/articles/${articleId}`);
    const article: { slug: string; status: string; title: string } = await res.json();
    expect(article.status).toBe("published");
    expect(article.title).toBe(articleTitle);
    articleSlug = article.slug;
    expect(articleSlug).toContain("connect-to-the-office-wi-fi");
  });

  test("a client reads, searches and votes on the article", async () => {
    const { a, owner } = ws;
    await a.page.goto(`${WEB}/portal/kb`);
    await expect(a.page.getByRole("heading", { name: "Help center" })).toBeVisible({ timeout: 15000 });
    await expect(a.page.getByRole("button", { name: new RegExp(collectionName) })).toBeVisible();
    await expect(a.page.getByRole("link", { name: new RegExp(articleTitle) })).toBeVisible();

    await a.page.getByLabel("Search articles").fill("office network");
    const results = a.page.getByRole("region", { name: "Search results" });
    await expect(results.getByRole("link", { name: new RegExp(articleTitle) })).toBeVisible({ timeout: 10000 });
    await results.getByRole("link", { name: new RegExp(articleTitle) }).click();

    await expect(a.page.getByRole("heading", { name: articleTitle })).toBeVisible({ timeout: 15000 });
    await expect(a.page.getByRole("heading", { name: "Steps" })).toBeVisible();
    await a.page.getByRole("button", { name: "Yes" }).click();
    await expect(a.page.getByText("Thanks for your feedback.")).toBeVisible();

    const res = await owner.request.get(`${API}/kb/articles/${articleId}`);
    const article: { helpfulYes: number; viewCount: number } = await res.json();
    expect(article.helpfulYes).toBe(1);
    expect(article.viewCount).toBeGreaterThanOrEqual(1);

    // Voting again does not count twice.
    const again = await a.page.request.post(`${API}/kb/mine/articles/${articleSlug}/feedback`, {
      data: { helpful: true },
      headers: { "x-csrf-token": await getCsrfTokenFromContext(a.context) },
    });
    expect(again.ok()).toBe(true);
    expect((await again.json()).helpfulYes).toBe(1);
  });

  test("internal and draft articles are invisible to clients", async () => {
    const { owner, ownerHeaders, a } = ws;
    const internal = await createArticle(owner, ownerHeaders, {
      title: `Internal escalation runbook ${stamp}`,
      body: "Escalation steps for staff.",
      visibility: "internal",
    });
    const draft = await createArticle(
      owner,
      ownerHeaders,
      { title: `Unreleased draft guide ${stamp}`, body: "Not ready.", visibility: "public" },
      false,
    );

    for (const slug of [internal.slug, draft.slug]) {
      const res = await a.page.request.get(`${API}/kb/mine/articles/${slug}`);
      expect(res.status()).toBe(404);
    }
    for (const q of ["escalation", "unreleased", stamp]) {
      const search = await a.page.request.get(`${API}/kb/mine/search?q=${encodeURIComponent(q)}`);
      expect(search.ok()).toBe(true);
      const titles: string = ((await search.json()) as { title: string }[]).map((r) => r.title).join("|");
      expect(titles).not.toContain("Internal escalation runbook");
      expect(titles).not.toContain("Unreleased draft guide");
    }
    // Staff search finds both, so the absence above is the visibility filter at work.
    const staffSearch = await owner.request.get(`${API}/kb/search?q=${encodeURIComponent("escalation")}`);
    expect(((await staffSearch.json()) as { title: string }[]).map((r) => r.title)).toContain(`Internal escalation runbook ${stamp}`);

    await a.page.goto(`${WEB}/portal/kb`);
    await expect(a.page.getByRole("link", { name: new RegExp(articleTitle) })).toBeVisible({ timeout: 15000 });
    await expect(a.page.getByText(`Internal escalation runbook ${stamp}`)).toHaveCount(0);
    await expect(a.page.getByText(`Unreleased draft guide ${stamp}`)).toHaveCount(0);

    // The deflection endpoint refuses hidden articles too.
    const deflect = await a.page.request.post(`${API}/kb/mine/deflections`, {
      data: { articleId: internal.id, outcome: "viewed" },
      headers: { "x-csrf-token": await getCsrfTokenFromContext(a.context) },
    });
    expect(deflect.status()).toBe(404);
  });

  test("a restricted article is visible only to its company", async () => {
    const { owner, ownerHeaders, a, b } = ws;
    const title = `Company A VPN profile ${stamp}`;
    const restricted = await createArticle(owner, ownerHeaders, {
      title,
      body: "Import the VPN profile for your site.",
      visibility: "restricted",
      audienceCompanyIds: [a.companyId],
    });

    expect((await a.page.request.get(`${API}/kb/mine/articles/${restricted.slug}`)).status()).toBe(200);
    expect((await b.page.request.get(`${API}/kb/mine/articles/${restricted.slug}`)).status()).toBe(404);

    const searchB = await b.page.request.get(`${API}/kb/mine/search?q=${encodeURIComponent("VPN profile")}`);
    expect(((await searchB.json()) as { title: string }[]).map((r) => r.title)).not.toContain(title);
    const suggestB = await b.page.request.get(`${API}/kb/mine/suggest?q=${encodeURIComponent("vpn profile not working")}`);
    expect(((await suggestB.json()) as { title: string }[]).map((r) => r.title)).not.toContain(title);

    await a.page.goto(`${WEB}/portal/kb/${restricted.slug}`);
    await expect(a.page.getByRole("heading", { name: title })).toBeVisible({ timeout: 15000 });

    await b.page.goto(`${WEB}/portal/kb/${restricted.slug}`);
    await expect(b.page.getByText("This article isn't available.")).toBeVisible({ timeout: 15000 });
    await expect(b.page.getByRole("heading", { name: title })).toHaveCount(0);
  });

  test("clients cannot use staff knowledge base routes", async () => {
    const { a } = ws;
    expect((await a.page.request.get(`${API}/kb/articles/${articleId}`)).status()).toBe(403);
    expect((await a.page.request.get(`${API}/kb/articles`)).status()).toBe(403);
    expect((await a.page.request.get(`${API}/kb/stats`)).status()).toBe(403);
  });

  test("another workspace cannot see these articles", async ({ browser }) => {
    const { context, page } = await createOwner(browser, `kb-other-${stamp}`);
    try {
      expect((await page.request.get(`${API}/kb/articles/${articleId}`)).status()).toBe(404);
      expect((await page.request.get(`${API}/kb/mine/articles/${articleSlug}`)).status()).toBe(404);
      const list = await page.request.get(`${API}/kb/articles`);
      expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(0);
      const del = await page.request.delete(`${API}/kb/articles/${articleId}`, {
        headers: { "x-csrf-token": await getCsrfTokenFromContext(context) },
      });
      expect(del.status()).toBe(404);
    } finally {
      await context.close();
    }
  });
});
