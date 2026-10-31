import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createPortalClientProject, getCsrfTokenFromContext } from "./helpers";
import type { PortalClientProject } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/**
 * Helpdesk: a portal client opens a ticket with an attachment, staff answer it
 * with a public reply and an internal note, the client only sees the reply,
 * rates and reopens it; staff work the queue (views, bulk close) and insert a
 * canned response.
 */
test.describe("Helpdesk", () => {
  let portal: PortalClientProject;
  let clientHeaders: Record<string, string>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    portal = await createPortalClientProject(browser, "helpdesk", "Helpdesk E2E");
    clientHeaders = { "x-csrf-token": await getCsrfTokenFromContext(portal.client.context()) };
  });

  test.afterAll(async () => {
    await portal?.close();
  });

  async function clientTicket(subject: string): Promise<string> {
    const res = await portal.client.request.post(`${API}/tickets/mine`, {
      data: { subject, description: `Details for ${subject}`, impact: "low", urgency: "low" },
      headers: clientHeaders,
    });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function staffTicketPage(id: string): Promise<Page> {
    await portal.owner.goto(`${WEB}/dashboard/tickets/${id}`);
    await expect(portal.owner.getByRole("list", { name: "Conversation" })).toBeVisible({ timeout: 15000 });
    return portal.owner;
  }

  test("client submits a ticket with an attachment, staff reply, internal note stays hidden", async () => {
    const client = portal.client;
    await client.goto(`${WEB}/portal/tickets`);
    await client.getByRole("link", { name: "New request" }).click();
    await client.getByLabel("Subject").fill("Printer offline on floor two");
    await client.getByLabel("Description").fill("The **printer** shows an error.");
    await client.getByLabel("Attachments").setInputFiles({ name: "error-log.txt", mimeType: "text/plain", buffer: Buffer.from("paper jam at tray 2") });
    await client.getByRole("button", { name: "Submit request" }).click();
    await client.waitForURL(/\/portal\/tickets\/[^/]+$/, { timeout: 15000 });
    const ticketId = client.url().split("/").pop() as string;
    await expect(client.getByRole("heading", { name: "Printer offline on floor two" })).toBeVisible();
    await expect(client.getByRole("button", { name: /error-log\.txt/ })).toBeVisible();

    const staff = await staffTicketPage(ticketId);
    await expect(staff.getByRole("button", { name: /error-log\.txt/ })).toBeVisible();
    await staff.getByRole("radio", { name: "Internal note" }).click();
    await staff.getByLabel("Message").fill("Toner supplier contract expired");
    await staff.getByRole("button", { name: "Add note" }).click();
    await expect(staff.getByText("Toner supplier contract expired")).toBeVisible();
    await staff.getByRole("radio", { name: "Public reply" }).click();
    await staff.getByLabel("Message").fill("Please power-cycle the printer.");
    await staff.getByRole("button", { name: "Send reply" }).click();
    await expect(staff.getByText("Please power-cycle the printer.")).toBeVisible();

    await client.reload();
    await expect(client.getByText("Please power-cycle the printer.")).toBeVisible({ timeout: 15000 });
    await expect(client.getByText("Toner supplier contract expired")).toHaveCount(0);
    const detail = await client.request.get(`${API}/tickets/mine/${ticketId}`);
    expect(JSON.stringify(await detail.json())).not.toContain("Toner supplier");
  });

  test("client rates and reopens a resolved ticket", async () => {
    const id = await clientTicket("Mailbox full");
    const resolve = await portal.owner.request.patch(`${API}/tickets/${id}`, { data: { status: "resolved" }, headers: portal.ownerHeaders });
    expect(resolve.ok()).toBeTruthy();

    const client = portal.client;
    await client.goto(`${WEB}/portal/tickets/${id}`);
    await expect(client.getByText("How did we do?")).toBeVisible({ timeout: 15000 });
    await client.getByRole("button", { name: "4 stars" }).click();
    await client.getByRole("button", { name: "Submit rating" }).click();
    await expect(client.getByText("Thanks for your feedback.")).toBeVisible();

    await client.getByRole("button", { name: "Reopen request" }).click();
    await expect(client.getByText("Open", { exact: true })).toBeVisible();
    const staffView = await portal.owner.request.get(`${API}/tickets/${id}`);
    const body: { status: string; csatRating: number } = await staffView.json();
    expect(body.status).toBe("open");
    expect(body.csatRating).toBe(4);
  });

  test("staff queue views and bulk close", async () => {
    const a = await clientTicket("Bulk VPN issue A");
    const b = await clientTicket("Bulk VPN issue B");
    const owner = portal.owner;
    await owner.goto(`${WEB}/dashboard/tickets`);
    await expect(owner.getByRole("link", { name: /Bulk VPN issue A/ })).toBeVisible({ timeout: 15000 });

    await owner.getByRole("button", { name: /^Unassigned/ }).click();
    await expect(owner.getByRole("link", { name: /Bulk VPN issue B/ })).toBeVisible();
    await owner.getByRole("button", { name: /^Mine/ }).click();
    await expect(owner.getByText("No tickets in this view.")).toBeVisible();
    await owner.getByRole("button", { name: /^Open/ }).click();

    await owner.getByPlaceholder("Subject or number...").fill("Bulk VPN issue");
    await expect(owner.getByTestId("ticket-row")).toHaveCount(2);
    await owner.getByRole("checkbox", { name: "Select all" }).check();
    await owner.getByRole("button", { name: "Close selected" }).click();
    await owner.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await expect(owner.getByText("Updated 2 ticket(s)")).toBeVisible();

    for (const id of [a, b]) {
      const res = await owner.request.get(`${API}/tickets/${id}`);
      expect(((await res.json()) as { status: string }).status).toBe("closed");
    }
  });

  test("canned response is inserted with variables filled", async () => {
    const id = await clientTicket("Password reset");
    const canned = await portal.owner.request.post(`${API}/helpdesk/canned-responses`, {
      data: { title: "E2E greeting", body: "Hello {{requester.firstName}}, about {{ticket.number}}" },
      headers: portal.ownerHeaders,
    });
    expect(canned.status()).toBe(201);
    const staff = await staffTicketPage(id);
    await staff.getByLabel("Insert canned response").selectOption({ label: "E2E greeting" });
    await expect(staff.getByLabel("Message")).toHaveValue(/^Hello Test, about TKT-\d+$/);
  });

  test("portal routes refuse staff-only endpoints", async () => {
    const res = await portal.client.request.get(`${API}/tickets`);
    expect(res.status()).toBe(403);
    const settings = await portal.client.request.get(`${API}/helpdesk/settings`);
    expect(settings.status()).toBe(403);
  });
});
