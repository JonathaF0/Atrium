import { test, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { contactIdByEmail, createOwner, getCsrfTokenFromContext, inviteAndAcceptClient, signIn } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/**
 * Estimates end to end: staff build an estimate from the catalog (item + bundle)
 * and send it; the client toggles an optional item and asks for changes; staff
 * revise and resend; the client accepts with a drawn signature; staff convert
 * it with a deposit into draft invoices and a signed document on a new project.
 */
test.describe.serial("Estimates", () => {
  let ownerCtx: BrowserContext;
  let owner: Page;
  let ownerHeaders: Record<string, string>;
  let clientCtx: BrowserContext;
  let client: Page;
  let clientUserId: string;
  let estimateId: string;
  let revisionId: string;
  let estimateNumber: string;
  const suffix = Date.now().toString(36);
  const title = `Office network refresh ${suffix}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180000);
    ({ context: ownerCtx, page: owner } = await createOwner(browser, "est"));
    ownerHeaders = { "x-csrf-token": await getCsrfTokenFromContext(ownerCtx) };
    const { clientEmail, password } = await inviteAndAcceptClient(browser, owner, "est-client");

    // Put the client in a company, as a client organization.
    const contactId = await contactIdByEmail(owner, clientEmail);
    const put = await owner.request.put(`${API}/contacts/${contactId}`, {
      data: { companyName: `Sample Company ${suffix}` },
      headers: ownerHeaders,
    });
    expect(put.ok()).toBe(true);

    const clientsRes = await owner.request.get(`${API}/estimates/clients`);
    expect(clientsRes.ok()).toBe(true);
    const clients: { recipients: Array<{ userId: string; email: string; companyId: string | null }> } = await clientsRes.json();
    const recipient = clients.recipients.find((r) => r.email === clientEmail.toLowerCase());
    expect(recipient?.companyId).toBeTruthy();
    clientUserId = recipient!.userId;

    // Catalog: a tax rate, three items, and a bundle with one optional item.
    const tax = await owner.request.post(`${API}/tax-rates`, {
      data: { name: "Sales tax", rateBps: 1000, isDefault: true },
      headers: ownerHeaders,
    });
    expect(tax.status()).toBe(201);
    const mk = async (data: Record<string, unknown>): Promise<string> => {
      const res = await owner.request.post(`${API}/catalog/items`, { data, headers: ownerHeaders });
      expect(res.status()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    await mk({ name: `Firewall appliance ${suffix}`, billingType: "fixed", rateCents: 120000, costCents: 80000 });
    const labour = await mk({ name: `Install labour ${suffix}`, billingType: "hourly", rateCents: 9000, costCents: 4000 });
    const support = await mk({ name: `Priority support ${suffix}`, billingType: "fixed", rateCents: 30000 });
    const bundle = await owner.request.post(`${API}/catalog/bundles`, {
      data: {
        name: `Install pack ${suffix}`,
        items: [
          { catalogItemId: labour, quantity: 4 },
          { catalogItemId: support, quantity: 1, optional: true },
        ],
      },
      headers: ownerHeaders,
    });
    expect(bundle.status()).toBe(201);

    ({ context: clientCtx, page: client } = await signIn(browser, clientEmail, password));
  });

  test.afterAll(async () => {
    await clientCtx?.close();
    await ownerCtx?.close();
  });

  test("staff build an estimate from the catalog and a bundle, then send it", async () => {
    await owner.goto(`${WEB}/dashboard/estimates/new`);
    await owner.getByLabel("Estimate title").fill(title);
    await owner.getByLabel("Recipient").selectOption(clientUserId);

    const picker = owner.getByTestId("catalog-picker");
    await picker.getByLabel("Search catalog").fill(`Firewall appliance ${suffix}`);
    await picker.getByRole("button", { name: `Add Firewall appliance ${suffix}` }).click();
    await picker.getByRole("button", { name: "Bundles" }).click();
    await picker.getByRole("button", { name: `Insert bundle Install pack ${suffix}` }).click();
    await expect(owner.getByTestId("builder-line")).toHaveCount(3);

    // 1200 + 4 x 90 = 1560 (+ optional 300 selected by default) = 1860; tax 10% on all = 186.
    await expect(owner.getByTestId("builder-total")).toContainText("2,046.00");
    await expect(owner.getByTestId("builder-margin")).toBeVisible();

    await owner.getByRole("button", { name: "Create draft" }).click();
    await owner.waitForURL(/\/dashboard\/estimates\/[a-z0-9]+$/, { timeout: 15000 });
    estimateId = owner.url().split("/").pop()!;
    await expect(owner.getByRole("heading", { level: 1 })).toContainText(/EST-\d+/);
    estimateNumber = (await owner.getByRole("heading", { level: 1 }).innerText()).match(/EST-\d+/)![0];

    await owner.getByRole("button", { name: "Send", exact: true }).click();
    await owner.getByRole("dialog").getByRole("button", { name: "Send" }).click();
    await expect(owner.getByText("Sent", { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(owner.getByTestId("margin-panel")).toBeVisible();
  });

  test("the client toggles an optional item and requests changes", async () => {
    await client.goto(`${WEB}/portal/estimates`);
    await client.getByTestId("portal-estimate-row").filter({ hasText: title }).click();
    await expect(client.getByRole("heading", { name: title })).toBeVisible({ timeout: 15000 });
    await expect(client.getByTestId("estimate-total")).toContainText("2,046.00");

    // Clients never see internal cost or margin.
    await expect(client.getByText(/margin/i)).toHaveCount(0);
    await expect(client.getByText("800.00")).toHaveCount(0);

    // The box follows the server's answer, so click and wait rather than uncheck().
    const option = client.getByLabel(`Include Priority support ${suffix}`);
    await option.click();
    await expect(option).not.toBeChecked();
    await expect(client.getByTestId("estimate-total")).toContainText("1,716.00");

    await client.getByRole("button", { name: "Request changes" }).click();
    await client.getByLabel("Requested changes").fill("Please add a second site visit.");
    await client.getByRole("button", { name: "Send request" }).click();
    await expect(client.getByText(/You asked for changes/)).toBeVisible();
    await expect(client.getByTestId("portal-estimate-comments")).toContainText("second site visit");
  });

  test("staff revise the estimate and send the new version", async () => {
    await owner.goto(`${WEB}/dashboard/estimates/${estimateId}`);
    await expect(owner.getByText("Changes requested").first()).toBeVisible({ timeout: 15000 });
    await expect(owner.getByTestId("estimate-comments")).toContainText("second site visit");
    await expect(owner.getByTestId("estimate-history")).toContainText("Viewed by client");

    await owner.getByRole("button", { name: "Revise" }).click();
    await owner.waitForURL((url) => !url.pathname.endsWith(estimateId), { timeout: 15000 });
    revisionId = owner.url().split("/").pop()!;
    await expect(owner.getByRole("heading", { level: 1 })).toContainText(`${estimateNumber} v2`);

    // Add a second visit as a custom line, save, and send.
    await owner.getByRole("button", { name: "Custom line" }).click();
    const last = owner.getByTestId("builder-line").last();
    await last.getByLabel("Line name").fill("Second site visit");
    await last.getByLabel("Unit price").fill("150");
    await owner.getByRole("button", { name: "Save draft" }).click();
    await expect(owner.getByText("Estimate saved")).toBeVisible();

    await owner.getByRole("button", { name: "Send", exact: true }).click();
    await owner.getByRole("dialog").getByRole("button", { name: "Send" }).click();
    await expect(owner.getByText("Sent", { exact: true }).first()).toBeVisible({ timeout: 10000 });

    const v1 = await owner.request.get(`${API}/estimates/${estimateId}`);
    expect(((await v1.json()) as { status: string }).status).toBe("superseded");
  });

  test("the client accepts the revision with a drawn signature", async () => {
    await client.goto(`${WEB}/portal/estimates/${revisionId}`);
    await expect(client.getByRole("heading", { level: 1 })).toContainText("v2", { timeout: 15000 });

    // The superseded version is no longer reachable for the client.
    const old = await client.request.get(`${API}/estimates/mine/${estimateId}`);
    expect(old.status()).toBe(404);

    await client.getByRole("button", { name: "Accept", exact: true }).click();
    const panel = client.getByTestId("accept-panel");
    await panel.getByLabel("Full name").fill("Sample Client");
    await panel.getByRole("button", { name: "Draw" }).click();
    const canvas = panel.locator("canvas");
    const box = (await canvas.boundingBox())!;
    await client.mouse.move(box.x + 30, box.y + 80);
    await client.mouse.down();
    await client.mouse.move(box.x + 120, box.y + 40, { steps: 8 });
    await client.mouse.move(box.x + 220, box.y + 110, { steps: 8 });
    await client.mouse.up();
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Accept estimate" }).click();
    await expect(client.getByText(/You accepted this estimate as Sample Client/)).toBeVisible({ timeout: 10000 });
  });

  test("staff convert with a deposit into draft invoices and a project document", async () => {
    await owner.goto(`${WEB}/dashboard/estimates/${revisionId}`);
    await expect(owner.getByText("Accepted and signed by Sample Client.")).toBeVisible({ timeout: 15000 });
    await expect(owner.getByTestId("estimate-history")).toContainText("Accepted");

    await owner.getByRole("button", { name: "Convert" }).click();
    const dialog = owner.getByRole("dialog", { name: "Convert estimate" });
    await dialog.getByText("Deposit now and the balance later").click();
    await dialog.getByLabel("Deposit percent").fill("30");
    await dialog.getByRole("button", { name: "Convert" }).click();

    const summary = owner.getByTestId("conversion-summary");
    await expect(summary).toBeVisible({ timeout: 15000 });
    await expect(summary.getByRole("link", { name: /INV-\d+/ })).toHaveCount(2);

    const detail: { projectId: string; invoices: Array<{ status: string }>; documentId: string } = await (
      await owner.request.get(`${API}/estimates/${revisionId}`)
    ).json();
    expect(detail.invoices.map((i) => i.status)).toEqual(["draft", "draft"]);
    expect(detail.documentId).toBeTruthy();

    // Converting again is refused.
    const again = await owner.request.post(`${API}/estimates/${revisionId}/convert`, {
      data: { project: "create", invoices: "full" },
      headers: ownerHeaders,
    });
    expect(again.status()).toBe(409);

    // The signed estimate is in the new project's documents.
    const docs = await owner.request.get(`${API}/documents/project/${detail.projectId}`);
    expect(docs.ok()).toBe(true);
    const docBody: { data: Array<{ title: string; status: string; type: string }> } = await docs.json();
    expect(docBody.data.find((d) => d.title.startsWith(`Estimate ${estimateNumber}`))).toMatchObject({ status: "accepted", type: "quote" });

    await owner.goto(`${WEB}/dashboard/projects/${detail.projectId}?tab=files`);
    await expect(owner.getByText(`Estimate ${estimateNumber}`, { exact: false }).first()).toBeVisible({ timeout: 15000 });
    await owner.goto(`${WEB}/dashboard/projects/${detail.projectId}?tab=invoices`);
    await expect(owner.getByText(/INV-\d+/).first()).toBeVisible({ timeout: 15000 });
  });
});
