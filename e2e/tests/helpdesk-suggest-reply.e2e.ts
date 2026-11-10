import { test, expect } from "@playwright/test";
import { createPortalClientProject, getCsrfTokenFromContext } from "./helpers";
import type { PortalClientProject } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/**
 * Suggested replies need an AI provider, which test servers don't have: the
 * button stays hidden and the endpoint refuses, and clients can never call it.
 * The drafting itself is covered by the unit tests with a mocked provider.
 */
test.describe("Suggested replies", () => {
  let portal: PortalClientProject;
  let ticketId: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    portal = await createPortalClientProject(browser, "hd-suggest", "Suggested replies");
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(portal.client.context()) };
    const res = await portal.client.request.post(`${API}/tickets/mine`, {
      data: { subject: "Printer offline", description: "Shows an error", impact: "low", urgency: "low" },
      headers,
    });
    ticketId = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async () => {
    await portal?.close();
  });

  test("without AI assist configured the button is hidden and the endpoint refuses", async () => {
    const status = await portal.owner.request.get(`${API}/helpdesk/ai-status`);
    expect(await status.json()).toEqual({ available: false });

    await portal.owner.goto(`${WEB}/dashboard/tickets/${ticketId}`);
    await expect(portal.owner.getByRole("button", { name: "Insert article..." })).toBeVisible({ timeout: 15000 });
    await expect(portal.owner.getByRole("button", { name: "Suggest reply" })).toHaveCount(0);

    const res = await portal.owner.request.post(`${API}/tickets/${ticketId}/suggest-reply`, { headers: portal.ownerHeaders });
    expect(res.status()).toBe(503);
  });

  test("portal clients cannot ask for a suggestion", async () => {
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(portal.client.context()) };
    expect((await portal.client.request.post(`${API}/tickets/${ticketId}/suggest-reply`, { headers })).status()).toBe(403);
    expect((await portal.client.request.get(`${API}/helpdesk/ai-status`)).status()).toBe(403);
  });
});
