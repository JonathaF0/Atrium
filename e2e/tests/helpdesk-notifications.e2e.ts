import { test, expect } from "@playwright/test";
import { createPortalClientProject, getCsrfTokenFromContext } from "./helpers";
import type { PortalClientProject } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

interface Notification {
  type: string;
  title: string;
  link: string | null;
}

/**
 * Staff hear about what clients do to their tickets: closing, reopening and
 * rating each show up in the owner's notifications, linking to the ticket.
 */
test.describe("Helpdesk notifications to staff", () => {
  let portal: PortalClientProject;
  let clientHeaders: Record<string, string>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    portal = await createPortalClientProject(browser, "hd-notify", "Helpdesk notify");
    clientHeaders = { "x-csrf-token": await getCsrfTokenFromContext(portal.client.context()) };
  });

  test.afterAll(async () => {
    await portal?.close();
  });

  async function ownerNotifications(): Promise<Notification[]> {
    const res = await portal.owner.request.get(`${API}/notifications?limit=50`);
    return ((await res.json()) as { data: Notification[] }).data;
  }

  async function newTicket(subject: string): Promise<string> {
    const res = await portal.client.request.post(`${API}/tickets/mine`, {
      data: { subject, description: "Details", impact: "low", urgency: "low" },
      headers: clientHeaders,
    });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  test("closing a ticket from the portal notifies staff", async () => {
    const id = await newTicket("Close me please");
    await portal.client.goto(`${WEB}/portal/tickets/${id}`);
    await portal.client.getByRole("button", { name: /close request/i }).click();
    await expect
      .poll(async () => (await ownerNotifications()).find((n) => n.type === "ticket_client_closed" && n.link === `/dashboard/tickets/${id}`), { timeout: 15000 })
      .toBeTruthy();
  });

  test("reopening and rating notify staff", async () => {
    const id = await newTicket("Reopen and rate");
    const resolved = await portal.owner.request.patch(`${API}/tickets/${id}`, { data: { status: "resolved" }, headers: portal.ownerHeaders });
    expect(resolved.ok()).toBe(true);

    const rate = await portal.client.request.post(`${API}/tickets/mine/${id}/csat`, { data: { rating: 2, comment: "Slow" }, headers: clientHeaders });
    expect(rate.ok()).toBe(true);
    const reopen = await portal.client.request.post(`${API}/tickets/mine/${id}/reopen`, { headers: clientHeaders });
    expect(reopen.ok()).toBe(true);

    await expect
      .poll(async () => {
        const types = (await ownerNotifications()).filter((n) => n.link === `/dashboard/tickets/${id}`).map((n) => n.type);
        return types.includes("ticket_rated") && types.includes("ticket_client_reopened");
      }, { timeout: 15000 })
      .toBe(true);
  });

  test("staff can turn helpdesk emails off without losing in-app notifications", async () => {
    const off = await portal.owner.request.put(`${API}/email-preferences`, { data: { helpdeskEmails: false }, headers: portal.ownerHeaders });
    expect(((await off.json()) as { helpdeskEmails: boolean }).helpdeskEmails).toBe(false);
    const id = await newTicket("Still notified in-app");
    await portal.client.request.post(`${API}/tickets/mine/${id}/close`, { headers: clientHeaders });
    await expect
      .poll(async () => (await ownerNotifications()).some((n) => n.type === "ticket_client_closed" && n.link === `/dashboard/tickets/${id}`), { timeout: 15000 })
      .toBe(true);
  });
});
