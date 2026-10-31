import { createHmac } from "crypto";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createOwner, getCsrfTokenFromContext, inviteAndAcceptClient } from "./helpers";

const API = "http://localhost:3001/api";
const WEB_URL = "http://localhost:3000";

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret. */
function totp(secret: string, time: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const code = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

async function enableTwoFactorInUi(page: Page, password: string): Promise<string> {
  await page.goto(`${WEB_URL}/dashboard/settings/account`);
  const section = page.getByRole("region", { name: /two-factor authentication/i });
  await expect(section).toBeVisible({ timeout: 15000 });
  await section.getByLabel(/current password/i).fill(password);
  await section.getByRole("button", { name: /set up two-factor/i }).click();
  const secret = ((await section.getByTestId("totp-secret").textContent()) ?? "").trim();
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  await section.getByLabel(/authentication code/i).fill(totp(secret));
  await section.getByRole("button", { name: /verify and turn on/i }).click();
  await expect(section.getByRole("list", { name: /backup codes/i })).toBeVisible({ timeout: 10000 });
  await section.getByRole("button", { name: /i saved my codes/i }).click();
  await expect(section.getByText(/you enter a code from your authenticator app/i)).toBeVisible();
  return secret;
}

test.describe("Two-factor authentication", () => {
  test("an owner enables TOTP, and signing in then asks for a code", async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page, email, password } = await createOwner(browser, "tfa-owner");
    const secret = await enableTwoFactorInUi(page, password);
    await context.close();

    const fresh = await browser.newContext({ storageState: undefined });
    const login = await fresh.newPage();
    await login.goto(`${WEB_URL}/login`);
    await login.getByLabel(/email/i).fill(email);
    await login.getByLabel(/password/i).fill(password);
    await login.getByRole("button", { name: /sign in/i }).click();
    await expect(login.getByRole("heading", { name: /two-factor authentication/i })).toBeVisible({ timeout: 15000 });

    // No session yet: the password alone does not sign in.
    expect((await login.request.get(`${API}/projects`)).status()).toBe(401);

    await login.getByLabel(/authentication code/i).fill("000000" === totp(secret) ? "111111" : "000000");
    await login.getByRole("button", { name: /^verify$/i }).click();
    await expect(login.getByText(/invalid|not valid/i)).toBeVisible({ timeout: 10000 });

    await login.getByLabel(/authentication code/i).fill(totp(secret));
    await login.getByRole("button", { name: /^verify$/i }).click();
    await login.waitForURL(/\/dashboard/, { timeout: 20000 });
    expect((await login.request.get(`${API}/projects`)).ok()).toBe(true);
    await fresh.close();
  });

  test("workspace enforcement sends an unenrolled client to set up 2FA", async ({ browser }) => {
    test.setTimeout(150_000);
    const { context, page: owner, password } = await createOwner(browser, "tfa-enforce");
    const client = await inviteAndAcceptClient(browser, owner, "tfa-client");
    await enableTwoFactorInUi(owner, password);

    const headers = { "x-csrf-token": await getCsrfTokenFromContext(context) };
    const res = await owner.request.put(`${API}/security/settings`, {
      headers,
      data: { requireTwoFactor: true, twoFactorScope: "all" },
    });
    expect(res.ok()).toBe(true);

    const clientContext = await browser.newContext({ storageState: undefined });
    const page = await clientContext.newPage();
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel(/email/i).fill(client.clientEmail);
    await page.getByLabel(/password/i).fill(client.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/two-factor-setup/, { timeout: 20000 });
    await expect(page.getByRole("heading", { name: /set up two-factor authentication/i })).toBeVisible();

    const blocked = await page.request.get(`${API}/invoices/mine`);
    expect(blocked.status()).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toBe("TWO_FACTOR_REQUIRED");

    // Staff-only scope releases the client again.
    const relax = await owner.request.put(`${API}/security/settings`, { headers, data: { twoFactorScope: "staff" } });
    expect(relax.ok()).toBe(true);
    await expect.poll(async () => (await page.request.get(`${API}/invoices/mine`)).status(), { timeout: 40000, intervals: [2000] }).toBe(200);

    await clientContext.close();
    await context.close();
  });

  test("only the owner can change enforcement, and only after enrolling", async ({ browser }) => {
    const { context, page: owner } = await createOwner(browser, "tfa-guard");
    const headers = { "x-csrf-token": await getCsrfTokenFromContext(context) };
    const res = await owner.request.put(`${API}/security/settings`, { headers, data: { requireTwoFactor: true } });
    expect(res.status()).toBe(400);

    const client = await inviteAndAcceptClient(browser, owner, "tfa-guard-client");
    const clientContext = await browser.newContext({ storageState: undefined });
    const page = await clientContext.newPage();
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel(/email/i).fill(client.clientEmail);
    await page.getByLabel(/password/i).fill(client.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/portal/, { timeout: 20000 });
    const clientHeaders = { "x-csrf-token": await getCsrfTokenFromContext(clientContext) };
    expect((await page.request.put(`${API}/security/settings`, { headers: clientHeaders, data: { requireTwoFactor: false } })).status()).toBe(403);
    await clientContext.close();
    await context.close();
  });
});
