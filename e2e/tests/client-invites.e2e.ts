import { test, expect } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { createOwner, getCsrfTokenFromContext, inviteAndAcceptClient, signIn } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/**
 * A CRM workflow (e.g. Salesforce on lead conversion) invites a client with an
 * API key: the contact and company are filled in, the invitation can be
 * accepted, repeats don't send another invite, and the key can't reach another
 * workspace or invite staff.
 */
test.describe("Client invites by API key", () => {
  let ownerContext: BrowserContext;
  let owner: Page;
  let ownerEmail: string;
  let headers: Record<string, string>;
  let key: string;
  let api: APIRequestContext;
  const stamp: string = Date.now().toString(36);
  const email = `lead-${stamp}@test.local`;

  test.beforeAll(async ({ browser, playwright }) => {
    test.setTimeout(120000);
    ({ context: ownerContext, page: owner, email: ownerEmail } = await createOwner(browser, "invite-api"));
    headers = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };
    const created = await owner.request.post(`${API}/api-keys`, { data: { name: `CRM ${stamp}` }, headers });
    expect(created.status()).toBe(201);
    key = ((await created.json()) as { key: string }).key;
    // A bare request context: no cookies, only the key, like a CRM callout.
    api = await playwright.request.newContext();
  });

  test.afterAll(async () => {
    await api?.dispose();
    await ownerContext?.close();
  });

  const invite = (data: Record<string, unknown>, token: string = key) =>
    api.post(`${API}/clients/invite`, { data, headers: { Authorization: `Bearer ${token}` } });

  test("a converted lead gets a contact, a company and an invitation they can accept", async ({ browser }) => {
    const res = await invite({
      email,
      firstName: "Lee",
      lastName: "Park",
      company: `Sample Recovery ${stamp}`,
      phone: "555-0100",
      externalId: "00Q000000000001",
    });
    expect(res.status()).toBe(200);
    const body: { status: string; contactId: string; companyId: string; invitationId: string } = await res.json();
    expect(body.status).toBe("invited");
    expect(body.companyId).toBeTruthy();

    const contact = await owner.request.get(`${API}/contacts/${body.contactId}`);
    const detail: { name: string; company: { name: string } | null; status: string } = await contact.json();
    expect(detail.name).toBe("Lee Park");
    expect(detail.company?.name).toBe(`Sample Recovery ${stamp}`);
    expect(detail.status).toBe("client");

    const clientCtx = await browser.newContext({ storageState: undefined });
    const page = await clientCtx.newPage();
    await page.goto(`${WEB}/accept-invite?id=${body.invitationId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /use a password instead/i }).click();
    await page.locator("#name").fill("Lee Park");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("Client123!");
    await page.getByRole("button", { name: /create account & join/i }).click();
    await expect(page).toHaveURL(/\/portal/, { timeout: 20000 });
    await clientCtx.close();

    const audit = await owner.request.get(`${API}/audit-log?action=member.invited`);
    expect(JSON.stringify(await audit.json())).toContain("00Q000000000001");
  });

  test("calling again for the same person doesn't invite twice", async () => {
    const pendingEmail = `pending-${stamp}@test.local`;
    expect(((await (await invite({ email: pendingEmail })).json()) as { status: string }).status).toBe("invited");
    expect(((await (await invite({ email: pendingEmail })).json()) as { status: string }).status).toBe("already_invited");
    // The first lead accepted in the test above.
    expect(((await (await invite({ email })).json()) as { status: string }).status).toBe("already_client");
  });

  test("staff emails, bad input and missing keys are refused", async () => {
    expect((await invite({ email: ownerEmail })).status()).toBe(409);
    expect((await invite({ email: "not-an-email" })).status()).toBe(400);
    expect((await invite({ email: `x-${stamp}@test.local`, role: "admin" })).status()).toBe(400);
    expect((await api.post(`${API}/clients/invite`, { data: { email: `y-${stamp}@test.local` } })).status()).toBe(401);
    expect((await invite({ email: `z-${stamp}@test.local` }, "atr_not-a-real-key")).status()).toBe(401);
  });

  test("a portal client cannot use it", async ({ browser }) => {
    const client = await inviteAndAcceptClient(browser, owner, "invite-api-client");
    const { context, page } = await signIn(browser, client.clientEmail, client.password);
    const res = await page.request.post(`${API}/clients/invite`, {
      data: { email: `w-${stamp}@test.local` },
      headers: { "x-csrf-token": await getCsrfTokenFromContext(context) },
    });
    expect(res.status()).toBe(403);
    await context.close();
  });

  test("the key only invites into its own workspace", async ({ browser }) => {
    const other = await createOwner(browser, "invite-api-other");
    const res = await invite({ email: `other-${stamp}@test.local` });
    const { contactId } = (await res.json()) as { contactId: string };
    expect((await other.page.request.get(`${API}/contacts/${contactId}`)).status()).toBe(404);
    await other.context.close();
  });
});
