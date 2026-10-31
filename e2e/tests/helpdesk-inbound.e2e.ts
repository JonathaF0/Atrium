import { createHmac } from "crypto";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { createOwner, getCsrfTokenFromContext, inviteAndAcceptClient } from "./helpers";

const API = "http://localhost:3001/api";
const WEB = "http://localhost:3000";

/**
 * Inbound email webhook: a signed message from a known contact opens a ticket
 * for them, a reply threads into it, an unknown sender lands in triage, and a
 * bad signature is rejected.
 */
test.describe("Helpdesk inbound email", () => {
  let ownerContext: BrowserContext;
  let owner: Page;
  let headers: Record<string, string>;
  let clientEmail: string;
  let secret: string;
  let slug: string;
  const stamp = Date.now().toString(36);

  async function post(request: APIRequestContext, payload: unknown, signature?: string) {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signature ?? `sha256=${createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex")}`;
    return request.post(`${API}/helpdesk/inbound/${slug}`, {
      data: body,
      headers: { "Content-Type": "application/json", "X-Atrium-Signature": sig, "X-Atrium-Timestamp": ts },
    });
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    ({ context: ownerContext, page: owner } = await createOwner(browser, "hd-inbound"));
    headers = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };
    ({ clientEmail } = await inviteAndAcceptClient(browser, owner, "hd-inbound-client"));

    const mode = await owner.request.patch(`${API}/helpdesk/inbound`, {
      data: { inboundMode: "webhook", inboundAddress: "support@example.com" },
      headers,
    });
    expect(mode.ok()).toBeTruthy();
    const rotated = await owner.request.post(`${API}/helpdesk/inbound/secret`, { headers });
    expect(rotated.status()).toBe(201);
    secret = ((await rotated.json()) as { secret: string }).secret;
    const settings: { inbound: { webhookUrl: string | null } } = await (await owner.request.get(`${API}/helpdesk/settings`)).json();
    expect(settings.inbound.webhookUrl).toBeTruthy();
    slug = (settings.inbound.webhookUrl as string).split("/").pop() as string;
  });

  test.afterAll(async () => {
    await ownerContext?.close();
  });

  test("a signed email from a known contact opens a ticket and a reply threads into it", async ({ request }) => {
    const first = await post(request, {
      from: `Test Client <${clientEmail}>`,
      to: "support@example.com",
      subject: `VPN down ${stamp}`,
      text: "I cannot connect to the VPN.",
      messageId: `<vpn-${stamp}@example.com>`,
      attachments: [{ filename: "vpn.log", contentType: "text/plain", content: Buffer.from("timeout").toString("base64") }],
    });
    expect(first.status()).toBe(200);
    const created: { status: string; ticketId: string } = await first.json();
    expect(created.status).toBe("ticket_created");

    const again = await post(request, { from: clientEmail, subject: "dup", text: "dup", messageId: `<vpn-${stamp}@example.com>` });
    expect(((await again.json()) as { status: string }).status).toBe("duplicate");

    const reply = await owner.request.post(`${API}/tickets/${created.ticketId}/messages`, { data: { body: "Try reconnecting now" }, headers });
    expect(reply.status()).toBe(201);
    const replyId = ((await reply.json()) as { id: string }).id;
    let outboundId = "";
    await expect
      .poll(async () => {
        const t: { messages: { id: string; emailMessageId: string | null }[] } = await (await owner.request.get(`${API}/tickets/${created.ticketId}`)).json();
        outboundId = t.messages.find((m) => m.id === replyId)?.emailMessageId ?? "";
        return outboundId;
      })
      .not.toBe("");

    const threaded = await post(request, {
      from: clientEmail,
      to: "support@example.com",
      subject: `Re: VPN down ${stamp}`,
      text: "Works now, thanks!\n\nOn Mon, Support <support@example.com> wrote:\n> Try reconnecting now",
      messageId: `<vpn-reply-${stamp}@example.com>`,
      inReplyTo: `<${outboundId}>`,
    });
    const threadedBody: { status: string; ticketId: string } = await threaded.json();
    expect(threadedBody).toEqual({ status: "reply_added", ticketId: created.ticketId });

    await owner.goto(`${WEB}/dashboard/tickets/${created.ticketId}`);
    await expect(owner.getByText("Works now, thanks!")).toBeVisible({ timeout: 15000 });
    await expect(owner.getByText(/On Mon, Support/)).toHaveCount(0);
    await expect(owner.getByRole("button", { name: /vpn\.log/ })).toBeVisible();
  });

  test("an unknown sender goes to triage without portal access", async ({ request }) => {
    const res = await post(request, {
      from: `stranger-${stamp}@example.org`,
      to: "support@example.com",
      subject: `Partnership inquiry ${stamp}`,
      text: "Hello there",
      messageId: `<stranger-${stamp}@example.org>`,
    });
    const body: { status: string; ticketId: string } = await res.json();
    expect(body.status).toBe("triaged");

    const ticket: { triage: boolean; requesterUserId: string | null } = await (await owner.request.get(`${API}/tickets/${body.ticketId}`)).json();
    expect(ticket.triage).toBe(true);
    expect(ticket.requesterUserId).toBeNull();

    await owner.goto(`${WEB}/dashboard/tickets?view=triage`);
    await expect(owner.getByRole("link", { name: new RegExp(`Partnership inquiry ${stamp}`) })).toBeVisible({ timeout: 15000 });
  });

  test("auto-replies are ignored", async ({ request }) => {
    const res = await post(request, {
      from: clientEmail,
      subject: "Out of office",
      text: "I am away",
      messageId: `<ooo-${stamp}@example.com>`,
      headers: { "Auto-Submitted": "auto-replied" },
    });
    expect(((await res.json()) as { status: string }).status).toBe("ignored");
  });

  test("a bad or missing signature is rejected", async ({ request }) => {
    const bad = await post(request, { from: clientEmail, subject: "x", text: "x", messageId: `<bad-${stamp}@x>` }, `sha256=${"0".repeat(64)}`);
    expect(bad.status()).toBe(401);
    const missing = await request.post(`${API}/helpdesk/inbound/${slug}`, { data: { from: clientEmail, subject: "x", text: "x" } });
    expect(missing.status()).toBe(401);
    const signedWithoutId = await post(request, { from: clientEmail, subject: "Signed without a message id", text: "x" });
    expect(signedWithoutId.status()).toBe(200);
    const wrongSlug = await request.post(`${API}/helpdesk/inbound/no-such-workspace-${stamp}`, { data: { from: clientEmail } });
    expect(wrongSlug.status()).toBe(401);
  });
});
