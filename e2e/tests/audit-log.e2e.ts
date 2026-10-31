import { test, expect } from "@playwright/test";
import { createOwner, getCsrfTokenFromContext, inviteAndAcceptClient, signIn } from "./helpers";

const API = "http://localhost:3001/api";
const WEB_URL = "http://localhost:3000";

test.describe("Audit log", () => {
  test("role changes and exports show up in the viewer, which clients cannot open", async ({ browser }) => {
    test.setTimeout(150_000);
    const { context, page: owner } = await createOwner(browser, "audit-owner");
    const promoted = await inviteAndAcceptClient(browser, owner, "audit-promoted");
    const client = await inviteAndAcceptClient(browser, owner, "audit-client");
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(context) };

    const clients = await owner.request.get(`${API}/clients?limit=100`);
    const body: { data: { id: string; user: { email: string } }[] } = await clients.json();
    const member = body.data.find((m) => m.user.email === promoted.clientEmail);
    if (!member) throw new Error("Invited member not found");

    const roleRes = await owner.request.put(`${API}/clients/${member.id}/role`, { headers, data: { role: "admin" } });
    expect(roleRes.ok()).toBe(true);
    const exportRes = await owner.request.get(`${API}/contacts/export`);
    expect(exportRes.ok()).toBe(true);

    await owner.goto(`${WEB_URL}/dashboard/settings/audit-log`);
    await expect(owner.getByRole("heading", { name: /audit log/i })).toBeVisible({ timeout: 15000 });
    const table = owner.getByRole("table");
    await expect(table.getByText("member.role_changed")).toBeVisible({ timeout: 15000 });
    await expect(table.getByText("export.contacts")).toBeVisible();

    // Filtering by action group narrows the list.
    await owner.getByLabel("Action").selectOption("export.");
    await expect(table.getByText("export.contacts")).toBeVisible();
    await expect(table.getByText("member.role_changed")).toHaveCount(0);

    // Exporting the log is itself audited.
    const download = owner.waitForEvent("download");
    await owner.getByRole("button", { name: /export csv/i }).click();
    expect((await download).suggestedFilename()).toBe("audit-log.csv");
    await expect
      .poll(async () => {
        const res = await owner.request.get(`${API}/audit-log?action=export.audit_log`);
        return ((await res.json()) as { data: unknown[] }).data.length;
      })
      .toBeGreaterThan(0);

    // A portal client gets neither the API nor the page.
    const { context: clientContext, page: clientPage } = await signIn(browser, client.clientEmail, client.password);
    expect((await clientPage.request.get(`${API}/audit-log`)).status()).toBe(403);
    expect((await clientPage.request.get(`${API}/audit-log/export`)).status()).toBe(403);
    await clientPage.goto(`${WEB_URL}/dashboard/settings/audit-log`);
    await clientPage.waitForURL(/\/portal/, { timeout: 15000 });
    await clientContext.close();

    // Another workspace sees none of these entries.
    const { context: otherContext, page: other } = await createOwner(browser, "audit-other");
    const otherLog = await other.request.get(`${API}/audit-log?action=member.`);
    const otherBody: { data: { summary: string | null }[] } = await otherLog.json();
    expect(otherBody.data).toHaveLength(0);
    await otherContext.close();
    await context.close();
  });
});
