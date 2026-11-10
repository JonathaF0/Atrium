import { test, expect } from "@playwright/test";
import { createPortalClientProject, getCsrfTokenFromContext } from "./helpers";
import type { PortalClientProject } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/** Staff time a ticket with a start/stop timer instead of typing minutes afterwards. */
test.describe("Ticket timer", () => {
  let portal: PortalClientProject;
  let ticketId: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    portal = await createPortalClientProject(browser, "hd-timer", "Ticket timer");
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(portal.client.context()) };
    const res = await portal.client.request.post(`${API}/tickets/mine`, {
      data: { subject: "Time me", description: "Needs a look", impact: "low", urgency: "low" },
      headers,
    });
    expect(res.status()).toBe(201);
    ticketId = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async () => {
    await portal?.close();
  });

  test("start and stop the timer from the ticket page", async () => {
    const owner = portal.owner;
    await owner.goto(`${WEB}/dashboard/tickets/${ticketId}`);
    const panel = owner.getByRole("region", { name: "Time" });
    await panel.getByLabel("Time description").fill("Remote session");
    await panel.getByRole("button", { name: "Start timer" }).click();
    await expect(panel.getByTestId("ticket-timer")).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText("running")).toBeVisible();

    const running = await owner.request.get(`${API}/time-entries/running`);
    expect(((await running.json()) as { ticketId: string }).ticketId).toBe(ticketId);

    await panel.getByRole("button", { name: "Stop timer" }).click();
    await expect(panel.getByRole("button", { name: "Start timer" })).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText(/Remote session/)).toBeVisible();
    // No running timer: Nest sends an empty body for null.
    expect((await (await owner.request.get(`${API}/time-entries/running`)).text()).trim()).toMatch(/^(null)?$/);

    const events = (await (await owner.request.get(`${API}/tickets/${ticketId}`)).json()) as { events: { type: string }[] };
    expect(events.events.some((e) => e.type === "time_logged")).toBe(true);
  });

  test("stopping is refused when the running timer belongs to something else", async () => {
    const start = await portal.owner.request.post(`${API}/time-entries/start`, {
      data: { projectId: portal.projectId },
      headers: portal.ownerHeaders,
    });
    expect(start.ok()).toBe(true);
    const stop = await portal.owner.request.post(`${API}/tickets/${ticketId}/timer/stop`, { headers: portal.ownerHeaders });
    expect(stop.status()).toBe(404);
    await portal.owner.request.post(`${API}/time-entries/stop`, { headers: portal.ownerHeaders });
  });

  test("portal clients cannot run the staff timer", async () => {
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(portal.client.context()) };
    expect((await portal.client.request.post(`${API}/tickets/${ticketId}/timer/start`, { data: {}, headers })).status()).toBe(403);
  });
});
