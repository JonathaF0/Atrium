import { test, expect } from "@playwright/test";
import { createPortalClientProject, getCsrfTokenFromContext } from "./helpers";
import type { PortalClientProject } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/** List filters behave predictably: tab and status combine sensibly, dropdowns list what exists, empty states say why. */
test.describe("List filters", () => {
  let portal: PortalClientProject;
  let closedId: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    portal = await createPortalClientProject(browser, "filters", "List filters");
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(portal.client.context()) };
    const created = await portal.client.request.post(`${API}/tickets/mine`, {
      data: { subject: "Already sorted", description: "Fixed itself", impact: "low", urgency: "low" },
      headers,
    });
    closedId = ((await created.json()) as { id: string }).id;
    // A bulk action, which is audited, so the audit log has a ticket entry to filter on.
    const closed = await portal.owner.request.post(`${API}/tickets/bulk`, {
      data: { ids: [closedId], action: "close" },
      headers: portal.ownerHeaders,
    });
    expect(closed.ok()).toBe(true);
  });

  test.afterAll(async () => {
    await portal?.close();
  });

  test("picking a status on the Open tab shows tickets with that status instead of nothing", async () => {
    const owner = portal.owner;
    await owner.goto(`${WEB}/dashboard/tickets`);
    await owner.getByLabel("Status").selectOption("closed");
    await expect(owner.getByTestId("ticket-row").filter({ hasText: "Already sorted" })).toBeVisible({ timeout: 15000 });
  });

  test("the audit log offers the action groups and target types it contains", async () => {
    const owner = portal.owner;
    await owner.goto(`${WEB}/dashboard/settings/audit-log`);
    const action = owner.getByLabel("Action");
    await expect(action.locator("option", { hasText: "Tickets" })).toHaveCount(1, { timeout: 15000 });
    await expect(owner.getByLabel("Target type").locator("option", { hasText: "Ticket" })).toHaveCount(1);
    await action.selectOption("ticket.");
    await expect(owner.getByRole("table").getByText(/^ticket\./).first()).toBeVisible();
  });

  test("an empty filtered list says the filters matched nothing", async () => {
    const owner = portal.owner;
    await owner.goto(`${WEB}/dashboard/contracts`);
    await owner.getByLabel("Status").selectOption("cancelled");
    await expect(owner.getByText("No contracts match these filters.")).toBeVisible({ timeout: 15000 });
  });
});
