import { test, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { contactIdByEmail, createOwner, getCsrfTokenFromContext, inviteAndAcceptClient, signIn } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/**
 * Estimates are visible only to their recipient (and that company's admins):
 * another client, another company and another workspace can't read or act on
 * them, and no client ever sees internal cost or margin.
 */
test.describe.serial("Estimates isolation", () => {
  const contexts: BrowserContext[] = [];
  let owner: Page;
  let ownerHeaders: Record<string, string>;
  let clientA: Page;
  let clientAHeaders: Record<string, string>;
  let clientB: Page;
  let clientBHeaders: Record<string, string>;
  let otherOwner: Page;
  let otherOwnerHeaders: Record<string, string>;
  let sentId: string;
  let draftId: string;
  const suffix = Date.now().toString(36);

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180000);
    const o = await createOwner(browser, "esti");
    contexts.push(o.context);
    owner = o.page;
    ownerHeaders = { "x-csrf-token": await getCsrfTokenFromContext(o.context) };

    const a = await inviteAndAcceptClient(browser, owner, "esti-a");
    const b = await inviteAndAcceptClient(browser, owner, "esti-b");
    for (const [email, company] of [
      [a.clientEmail, `Client Company A ${suffix}`],
      [b.clientEmail, `Client Company B ${suffix}`],
    ]) {
      const id = await contactIdByEmail(owner, email);
      const res = await owner.request.put(`${API}/contacts/${id}`, { data: { companyName: company }, headers: ownerHeaders });
      expect(res.ok()).toBe(true);
    }
    const clients: { recipients: Array<{ userId: string; email: string }> } = await (await owner.request.get(`${API}/estimates/clients`)).json();
    const aUserId = clients.recipients.find((r) => r.email === a.clientEmail.toLowerCase())!.userId;

    const lineItems = [{ name: "Managed firewall", billingType: "fixed", quantity: 1, unitPriceCents: 100000, costCents: 61234 }];
    const sent = await owner.request.post(`${API}/estimates`, {
      data: { title: `Isolated estimate ${suffix}`, recipientUserId: aUserId, lineItems },
      headers: ownerHeaders,
    });
    expect(sent.status()).toBe(201);
    sentId = ((await sent.json()) as { id: string }).id;
    expect((await owner.request.post(`${API}/estimates/${sentId}/send`, { headers: ownerHeaders })).ok()).toBe(true);

    const draft = await owner.request.post(`${API}/estimates`, {
      data: { title: `Draft estimate ${suffix}`, recipientUserId: aUserId, lineItems },
      headers: ownerHeaders,
    });
    draftId = ((await draft.json()) as { id: string }).id;

    const ca = await signIn(browser, a.clientEmail, a.password);
    const cb = await signIn(browser, b.clientEmail, b.password);
    contexts.push(ca.context, cb.context);
    clientA = ca.page;
    clientB = cb.page;
    clientAHeaders = { "x-csrf-token": await getCsrfTokenFromContext(ca.context) };
    clientBHeaders = { "x-csrf-token": await getCsrfTokenFromContext(cb.context) };

    const other = await createOwner(browser, "esti-other");
    contexts.push(other.context);
    otherOwner = other.page;
    otherOwnerHeaders = { "x-csrf-token": await getCsrfTokenFromContext(other.context) };
  });

  test.afterAll(async () => {
    for (const c of contexts) await c.close();
  });

  test("the recipient sees the estimate without cost or margin", async () => {
    const res = await clientA.request.get(`${API}/estimates/mine/${sentId}`);
    expect(res.ok()).toBe(true);
    const text = await res.text();
    expect(text).not.toContain("costCents");
    expect(text).not.toContain("margin");
    expect(text).not.toContain("61234");

    await clientA.goto(`${WEB}/portal/estimates/${sentId}`);
    await expect(clientA.getByRole("heading", { name: `Isolated estimate ${suffix}` })).toBeVisible({ timeout: 15000 });
    await expect(clientA.getByText("612.34")).toHaveCount(0);
    await expect(clientA.getByText(/margin/i)).toHaveCount(0);
  });

  test("the recipient can't see drafts or use staff endpoints", async () => {
    expect((await clientA.request.get(`${API}/estimates/mine/${draftId}`)).status()).toBe(404);
    const list: { data: Array<{ id: string }> } = await (await clientA.request.get(`${API}/estimates/mine`)).json();
    expect(list.data.map((e) => e.id)).toEqual([sentId]);
    expect((await clientA.request.get(`${API}/estimates`)).status()).toBe(403);
    expect((await clientA.request.get(`${API}/estimates/${sentId}`)).status()).toBe(403);
    expect((await clientA.request.get(`${API}/estimates/${sentId}/pdf`)).status()).toBe(403);
    expect((await clientA.request.get(`${API}/catalog/items`)).status()).toBe(403);
    expect((await clientA.request.post(`${API}/estimates/${sentId}/convert`, {
      data: { project: "create", invoices: "full" },
      headers: clientAHeaders,
    })).status()).toBe(403);
  });

  test("another client of another company can't see or answer it", async () => {
    const list: { data: unknown[] } = await (await clientB.request.get(`${API}/estimates/mine`)).json();
    expect(list.data).toHaveLength(0);
    expect((await clientB.request.get(`${API}/estimates/mine/${sentId}`)).status()).toBe(404);
    expect((await clientB.request.get(`${API}/estimates/mine/${sentId}/pdf`)).status()).toBe(404);
    expect((await clientB.request.post(`${API}/estimates/mine/${sentId}/decline`, {
      data: { reason: "not mine" },
      headers: clientBHeaders,
    })).status()).toBe(404);
    expect((await clientB.request.post(`${API}/estimates/mine/${sentId}/comments`, {
      data: { content: "hello" },
      headers: clientBHeaders,
    })).status()).toBe(404);

    await clientB.goto(`${WEB}/portal/estimates`);
    await expect(clientB.getByText("No estimates yet.")).toBeVisible({ timeout: 15000 });
    await clientB.goto(`${WEB}/portal/estimates/${sentId}`);
    await expect(clientB.getByText("Estimate not found.")).toBeVisible({ timeout: 15000 });

    // Still open for the real recipient.
    const still: { status: string } = await (await clientA.request.get(`${API}/estimates/mine/${sentId}`)).json();
    expect(still.status).toBe("viewed");
  });

  test("another workspace can't see or act on it", async () => {
    expect((await otherOwner.request.get(`${API}/estimates/${sentId}`)).status()).toBe(404);
    const list: { data: Array<{ id: string }> } = await (await otherOwner.request.get(`${API}/estimates`)).json();
    expect(list.data.find((e) => e.id === sentId)).toBeUndefined();
    expect((await otherOwner.request.post(`${API}/estimates/${sentId}/revise`, { headers: otherOwnerHeaders })).status()).toBe(404);
    expect((await otherOwner.request.delete(`${API}/estimates/${draftId}`, { headers: otherOwnerHeaders })).status()).toBe(404);
    expect((await otherOwner.request.get(`${API}/estimates/mine/${sentId}`)).status()).toBe(404);

    await otherOwner.goto(`${WEB}/dashboard/estimates/${sentId}`);
    await expect(otherOwner.getByText("Estimate not found.")).toBeVisible({ timeout: 15000 });
  });

  test("staff can't address an estimate to another workspace's client", async () => {
    const clients: { recipients: Array<{ userId: string }> } = await (await owner.request.get(`${API}/estimates/clients`)).json();
    const res = await otherOwner.request.post(`${API}/estimates`, {
      data: { title: "Cross-workspace", recipientUserId: clients.recipients[0].userId, lineItems: [] },
      headers: otherOwnerHeaders,
    });
    expect(res.status()).toBe(400);
  });
});
