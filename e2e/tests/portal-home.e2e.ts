import { test, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { createPortalClientProject, inviteAndAcceptClient, signIn } from "./helpers";
import type { PortalClientProject } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/**
 * The portal landing page: widgets render with the client's own data, and a
 * second client in the same workspace sees none of it.
 */
test.describe("Portal home", () => {
  test.describe.configure({ mode: "serial" });

  let portal: PortalClientProject;
  let clientBContext: BrowserContext;
  let clientB: Page;
  const suffix = Date.now().toString(36);
  const updateA = `Home update A ${suffix}`;
  const updateB = `Home update B ${suffix}`;
  let sentA = "";
  let draftA = "";
  let sentB = "";

  async function invoice(projectId: string, send: boolean): Promise<string> {
    const res = await portal.owner.request.post(`${API}/invoices`, {
      data: { projectId, lineItems: [{ description: "Sample service", quantity: 2, unitPrice: 4500 }] },
      headers: portal.ownerHeaders,
    });
    expect(res.status(), await res.text()).toBe(201);
    const created: { id: string; invoiceNumber: string } = await res.json();
    if (send) {
      const sent = await portal.owner.request.put(`${API}/invoices/${created.id}`, {
        data: { status: "sent" },
        headers: portal.ownerHeaders,
      });
      expect(sent.ok()).toBe(true);
    }
    return created.invoiceNumber;
  }

  async function postUpdate(projectId: string, content: string): Promise<void> {
    const form = new URLSearchParams();
    form.append("content", content);
    const res = await portal.owner.request.post(`${API}/updates?projectId=${projectId}`, {
      data: form.toString(),
      headers: { ...portal.ownerHeaders, "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status(), await res.text()).toBe(201);
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    portal = await createPortalClientProject(browser, "home", `Home Project A ${suffix}`);

    const b = await inviteAndAcceptClient(browser, portal.owner, "home-b");
    const clients = await portal.owner.request.get(`${API}/clients?limit=100`);
    const rows: { userId: string; user: { email: string } }[] = (await clients.json()).data;
    const bUserId = rows.find((r) => r.user.email === b.clientEmail)?.userId;
    expect(bUserId).toBeTruthy();
    const projectB = await portal.owner.request.post(`${API}/projects`, {
      data: { name: `Home Project B ${suffix}`, clientUserIds: [bUserId] },
      headers: portal.ownerHeaders,
    });
    expect(projectB.ok(), await projectB.text()).toBe(true);
    const projectBId: string = (await projectB.json()).id;

    sentA = await invoice(portal.projectId, true);
    draftA = await invoice(portal.projectId, false);
    sentB = await invoice(projectBId, true);
    await postUpdate(portal.projectId, updateA);
    await postUpdate(projectBId, updateB);

    ({ context: clientBContext, page: clientB } = await signIn(browser, b.clientEmail, b.password));
  });

  test.afterAll(async () => {
    await clientBContext?.close();
    await portal?.close();
  });

  test("widgets render with the client's own data", async () => {
    const client = portal.client;
    await client.goto(`${WEB}/portal`);
    await expect(client.getByRole("heading", { name: /welcome back/i })).toBeVisible({ timeout: 15_000 });

    const invoices = client.getByTestId("home-invoices");
    await expect(invoices).toContainText(sentA, { timeout: 15_000 });
    await expect(invoices).not.toContainText(draftA);
    await expect(invoices).not.toContainText(sentB);
    await expect(client.getByTestId("home-outstanding-total")).toBeVisible();

    const updates = client.getByTestId("home-updates");
    await expect(updates).toContainText(updateA);
    await expect(updates).not.toContainText(updateB);

    await expect(client.getByTestId("home-tickets")).toBeVisible();
    await expect(client.getByTestId("home-renewals")).toBeVisible();
    await expect(client.getByTestId("home-announcements")).toBeVisible();

    await expect(client.getByRole("link", { name: "New ticket" })).toHaveAttribute("href", "/portal/tickets/new");
    await expect(client.getByLabel("Quick actions").getByRole("link", { name: "Help center" })).toHaveAttribute("href", "/portal/kb");
    await expect(client.getByRole("link", { name: "Pay invoice" })).toHaveAttribute(
      "href",
      `/portal/projects/${portal.projectId}?tab=invoices`,
    );
    await expect(client.getByRole("link", { name: "Request work" })).toHaveAttribute(
      "href",
      `/portal/projects/${portal.projectId}?tab=tasks`,
    );
  });

  test("another client in the workspace sees only their own data", async () => {
    await clientB.goto(`${WEB}/portal`);
    await expect(clientB.getByRole("heading", { name: /welcome back/i })).toBeVisible({ timeout: 15_000 });
    await expect(clientB.getByTestId("home-invoices")).toContainText(sentB, { timeout: 15_000 });
    await expect(clientB.getByTestId("home-invoices")).not.toContainText(sentA);
    await expect(clientB.getByTestId("home-updates")).toContainText(updateB);
    await expect(clientB.getByTestId("home-updates")).not.toContainText(updateA);

    const res = await clientB.request.get(`${API}/portal-home/mine`);
    expect(res.ok()).toBe(true);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(sentA);
    expect(body).not.toContain(draftA);
    expect(body).not.toContain(updateA);
    expect(body).not.toContain(portal.projectId);
  });

  test("drafts never appear, even for the client they belong to", async () => {
    const res = await portal.client.request.get(`${API}/portal-home/mine`);
    const home: { invoices: { latest: { invoiceNumber: string; status: string }[] } } = await res.json();
    expect(home.invoices.latest.map((i) => i.invoiceNumber)).toContain(sentA);
    expect(home.invoices.latest.every((i) => i.status === "sent" || i.status === "overdue")).toBe(true);
    expect(JSON.stringify(home)).not.toContain(draftA);
  });

  test("the portal header links to home, projects and announcements", async () => {
    const header = portal.client.locator("header");
    await portal.client.goto(`${WEB}/portal/projects`);
    await expect(header.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("href", "/portal");
    await expect(header.getByRole("link", { name: "Projects", exact: true })).toHaveAttribute("href", "/portal/projects");
    await expect(header.getByRole("link", { name: /^Announcements/ })).toHaveAttribute("href", "/portal/announcements");
  });
});
