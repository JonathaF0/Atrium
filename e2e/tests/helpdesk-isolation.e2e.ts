import { test, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { contactIdByEmail, createOwner, getCsrfTokenFromContext, inviteAndAcceptClient, signIn } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

interface Client {
  context: BrowserContext;
  page: Page;
  headers: Record<string, string>;
}

/**
 * Tickets are private to their requester; a company admin also sees their
 * company's tickets; nothing crosses companies or workspaces.
 */
test.describe("Helpdesk isolation", () => {
  let ownerContext: BrowserContext;
  let owner: Page;
  let ownerHeaders: Record<string, string>;
  let clientA: Client;
  let clientB: Client;
  let companyAdmin: Client;
  let otherOwnerContext: BrowserContext;
  let otherOwner: Page;
  let otherClient: Client;
  let ticketA: string;
  let attachmentA: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240000);
    ({ context: ownerContext, page: owner } = await createOwner(browser, "hd-iso-owner"));
    ownerHeaders = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };

    const join = async (prefix: string): Promise<{ email: string; client: Client }> => {
      const { clientEmail, password } = await inviteAndAcceptClient(browser, owner, prefix);
      const { context, page } = await signIn(browser, clientEmail, password);
      return { email: clientEmail, client: { context, page, headers: { "x-csrf-token": await getCsrfTokenFromContext(context) } } };
    };
    const a = await join("hd-iso-a");
    const b = await join("hd-iso-b");
    const admin = await join("hd-iso-admin");
    clientA = a.client;
    clientB = b.client;
    companyAdmin = admin.client;

    const company = async (name: string): Promise<string> => {
      const res = await owner.request.post(`${API}/companies`, { data: { name }, headers: ownerHeaders });
      expect(res.status()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const sample = await company(`Sample Co ${Date.now()}`);
    const other = await company(`Other Co ${Date.now()}`);
    const setCompany = async (email: string, companyId: string): Promise<string> => {
      const id = await contactIdByEmail(owner, email);
      const res = await owner.request.put(`${API}/contacts/${id}`, { data: { companyId }, headers: ownerHeaders });
      expect(res.ok()).toBeTruthy();
      return id;
    };
    await setCompany(a.email, sample);
    await setCompany(b.email, other);
    const adminContact = await setCompany(admin.email, sample);
    const grant = await owner.request.put(`${API}/helpdesk/contacts/${adminContact}/company-admin`, { data: { companyAdmin: true }, headers: ownerHeaders });
    expect(grant.ok()).toBeTruthy();

    const created = await clientA.page.request.post(`${API}/tickets/mine`, {
      data: { subject: "Isolation ticket A", description: "Only A and their company admin" },
      headers: clientA.headers,
    });
    expect(created.status()).toBe(201);
    const ticket: { id: string; messages: { id: string }[] } = await created.json();
    ticketA = ticket.id;
    const upload = await clientA.page.request.post(`${API}/tickets/mine/${ticketA}/attachments?messageId=${ticket.messages[0].id}`, {
      multipart: { file: { name: "a-only.txt", mimeType: "text/plain", buffer: Buffer.from("private") } },
      headers: clientA.headers,
    });
    expect(upload.status()).toBe(201);
    attachmentA = ((await upload.json()) as { id: string }).id;

    ({ context: otherOwnerContext, page: otherOwner } = await createOwner(browser, "hd-iso-other"));
    const o = await inviteAndAcceptClient(browser, otherOwner, "hd-iso-other-client");
    const signedIn = await signIn(browser, o.clientEmail, o.password);
    otherClient = { ...signedIn, headers: { "x-csrf-token": await getCsrfTokenFromContext(signedIn.context) } };
  });

  test.afterAll(async () => {
    for (const c of [clientA, clientB, companyAdmin, otherClient]) await c?.context.close();
    await ownerContext?.close();
    await otherOwnerContext?.close();
  });

  test("a client of another company cannot see the ticket or its attachment", async () => {
    expect((await clientB.page.request.get(`${API}/tickets/mine/${ticketA}`)).status()).toBe(404);
    expect((await clientB.page.request.get(`${API}/tickets/mine/attachments/${attachmentA}`)).status()).toBe(404);
    const list = await clientB.page.request.get(`${API}/tickets/mine`);
    expect(JSON.stringify(await list.json())).not.toContain(ticketA);
    const reply = await clientB.page.request.post(`${API}/tickets/mine/${ticketA}/reply`, { data: { body: "hi" }, headers: clientB.headers });
    expect(reply.status()).toBe(404);

    await clientB.page.goto(`${WEB}/portal/tickets`);
    await expect(clientB.page.getByRole("heading", { name: "Support" })).toBeVisible({ timeout: 15000 });
    await expect(clientB.page.getByText("Isolation ticket A")).toHaveCount(0);
  });

  test("the company admin sees the colleague's ticket", async () => {
    const res = await companyAdmin.page.request.get(`${API}/tickets/mine/${ticketA}`);
    expect(res.status()).toBe(200);
    await companyAdmin.page.goto(`${WEB}/portal/tickets`);
    await expect(companyAdmin.page.getByText("Isolation ticket A")).toBeVisible({ timeout: 15000 });
    await expect(companyAdmin.page.getByLabel("Whose requests")).toBeVisible();
    await companyAdmin.page.getByLabel("Whose requests").selectOption("mine");
    await expect(companyAdmin.page.getByText("Isolation ticket A")).toHaveCount(0);
  });

  test("the requester sees their own ticket in the portal", async () => {
    await clientA.page.goto(`${WEB}/portal/tickets/${ticketA}`);
    await expect(clientA.page.getByRole("heading", { name: "Isolation ticket A" })).toBeVisible({ timeout: 15000 });
    await expect(clientA.page.getByRole("button", { name: /a-only\.txt/ })).toBeVisible();
  });

  test("another workspace cannot reach the ticket", async () => {
    expect((await otherOwner.request.get(`${API}/tickets/${ticketA}`)).status()).toBe(404);
    expect((await otherOwner.request.get(`${API}/tickets/attachments/${attachmentA}`)).status()).toBe(404);
    const queue = await otherOwner.request.get(`${API}/tickets?view=all`);
    expect(JSON.stringify(await queue.json())).not.toContain(ticketA);
    const patch = await otherOwner.request.patch(`${API}/tickets/${ticketA}`, {
      data: { status: "closed" },
      headers: { "x-csrf-token": await getCsrfTokenFromContext(otherOwnerContext) },
    });
    expect(patch.status()).toBe(404);
    expect((await otherClient.page.request.get(`${API}/tickets/mine/${ticketA}`)).status()).toBe(404);
  });

  test("portal clients cannot use staff ticket routes", async () => {
    expect((await clientA.page.request.get(`${API}/tickets/${ticketA}`)).status()).toBe(403);
    const bulk = await clientA.page.request.post(`${API}/tickets/bulk`, { data: { ids: [ticketA], action: "close" }, headers: clientA.headers });
    expect(bulk.status()).toBe(403);
  });
});
