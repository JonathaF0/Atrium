import { test, expect } from "@playwright/test";
import { getCsrfTokenFromContext } from "./helpers";
import { API, WEB, createArticle, createTwoCompanyWorkspace } from "./kb-helpers";
import type { TwoCompanyWorkspace } from "./kb-helpers";

/**
 * Client documentation (per company, client-visible or staff-only) and the
 * public help center switch.
 */
test.describe("Client documentation", () => {
  test.describe.configure({ mode: "serial" });

  let ws: TwoCompanyWorkspace;
  const stamp: string = Date.now().toString(36);
  const sharedTitle = `Office network layout ${stamp}`;
  const staffOnlyTitle = `Contract notes ${stamp}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180000);
    ws = await createTwoCompanyWorkspace(browser, `docs-${stamp}`);
  });

  test.afterAll(async () => {
    await ws?.close();
  });

  test("staff document a company from its page", async () => {
    const { owner, a } = ws;
    await owner.goto(`${WEB}/dashboard/contacts/companies/${a.companyId}`);
    const section = owner.getByRole("region", { name: "Documentation" });
    await expect(section).toBeVisible({ timeout: 15000 });
    await expect(section.getByText(/Never store passwords/)).toBeVisible();

    await section.getByRole("button", { name: "+ Add document" }).click();
    await section.getByLabel("Document title").fill(sharedTitle);
    await section.getByLabel("Document body").fill("Main switch in the comms room. Guest VLAN 30.");
    await section.getByLabel("Vault link").fill("https://vault.example.com/items/network");
    await section.getByRole("button", { name: "Save document" }).click();
    await expect(section.getByText(sharedTitle)).toBeVisible();
  });

  test("documents with passwords are rejected", async () => {
    const { owner, ownerHeaders, a } = ws;
    const res = await owner.request.post(`${API}/client-docs`, {
      data: { companyId: a.companyId, title: "Firewall", body: "Admin password: Winter2026!" },
      headers: ownerHeaders,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain("password vault");

    const badVault = await owner.request.post(`${API}/client-docs`, {
      data: { companyId: a.companyId, title: "Firewall", vaultUrl: "http://vault.example.com/x" },
      headers: ownerHeaders,
    });
    expect(badVault.status()).toBe(400);
  });

  test("staff-only notes stay hidden from the company", async () => {
    const { owner, ownerHeaders, a } = ws;
    const res = await owner.request.post(`${API}/client-docs`, {
      data: { companyId: a.companyId, title: staffOnlyTitle, body: "Renewal terms to discuss.", clientVisible: false },
      headers: ownerHeaders,
    });
    expect(res.status()).toBe(201);

    const mine = await a.page.request.get(`${API}/client-docs/mine`);
    expect(mine.ok()).toBe(true);
    const titles: string[] = ((await mine.json()) as { title: string }[]).map((d) => d.title);
    expect(titles).toContain(sharedTitle);
    expect(titles).not.toContain(staffOnlyTitle);

    await a.page.goto(`${WEB}/portal/docs`);
    await expect(a.page.getByRole("heading", { name: "Documentation" })).toBeVisible({ timeout: 15000 });
    await expect(a.page.getByText(sharedTitle)).toBeVisible();
    await expect(a.page.getByText("Guest VLAN 30")).toBeVisible();
    await expect(a.page.getByRole("link", { name: /Open in password vault/ })).toBeVisible();
    await expect(a.page.getByText(staffOnlyTitle)).toHaveCount(0);
  });

  test("company A's docs are invisible to company B", async () => {
    const { b, a } = ws;
    const mine = await b.page.request.get(`${API}/client-docs/mine`);
    expect(await mine.json()).toEqual([]);
    expect((await b.page.request.get(`${API}/client-docs?companyId=${a.companyId}`)).status()).toBe(403);

    await b.page.goto(`${WEB}/portal/docs`);
    await expect(b.page.getByText("No documentation has been shared with you yet.")).toBeVisible({ timeout: 15000 });
    await expect(b.page.getByText(sharedTitle)).toHaveCount(0);

    const write = await b.page.request.post(`${API}/client-docs`, {
      data: { companyId: b.companyId, title: "Sneaky" },
      headers: { "x-csrf-token": await getCsrfTokenFromContext(b.context) },
    });
    expect(write.status()).toBe(403);
  });

  test("the public help center is off by default, then serves public articles only", async ({ browser }) => {
    const { owner, ownerHeaders, orgSlug } = ws;
    const publicTitle = `Reset your password ${stamp}`;
    const clientsTitle = `Clients only printing guide ${stamp}`;
    const publicArticle = await createArticle(owner, ownerHeaders, {
      title: publicTitle,
      body: "Use the self-service reset link on the sign-in page.",
      visibility: "public",
    });
    await createArticle(owner, ownerHeaders, { title: clientsTitle, body: "Printer queues.", visibility: "clients" });

    const anon = await browser.newContext({ storageState: undefined });
    const page = await anon.newPage();
    try {
      expect((await page.request.get(`${API}/kb/public/${orgSlug}/articles`)).status()).toBe(404);
      const off = await page.goto(`${WEB}/help/${orgSlug}`);
      expect(off?.status()).toBe(404);

      const enable = await owner.request.patch(`${API}/kb/settings`, { data: { kbPublicEnabled: true }, headers: ownerHeaders });
      expect(enable.ok()).toBe(true);

      const on = await page.goto(`${WEB}/help/${orgSlug}`);
      expect(on?.status()).toBe(200);
      await expect(page.getByRole("link", { name: new RegExp(publicTitle) })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(clientsTitle)).toHaveCount(0);

      await page.getByRole("link", { name: new RegExp(publicTitle) }).click();
      await expect(page.getByRole("heading", { name: publicTitle })).toBeVisible({ timeout: 15000 });
      expect((await page.request.get(`${API}/kb/public/${orgSlug}/articles/${publicArticle.slug}`)).status()).toBe(200);

      const search = await page.request.get(`${API}/kb/public/${orgSlug}/search?q=${encodeURIComponent("printing guide")}`);
      expect(((await search.json()) as { title: string }[]).map((r) => r.title)).not.toContain(clientsTitle);

      // Client docs are never public.
      expect((await page.request.get(`${API}/client-docs/mine`)).status()).toBe(401);
    } finally {
      await owner.request.patch(`${API}/kb/settings`, { data: { kbPublicEnabled: false }, headers: ownerHeaders });
      await anon.close();
    }
  });
});
