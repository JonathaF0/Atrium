import { expect } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { contactIdByEmail, createOwner, getCsrfTokenFromContext, inviteAndAcceptClient, signIn } from "./helpers";

export const API = "http://localhost:3001/api";
export const WEB = "http://localhost:3000";

export interface CompanyClient {
  page: Page;
  context: BrowserContext;
  email: string;
  companyId: string;
}

/**
 * A fresh workspace with two portal clients, each the contact of a different
 * CRM company, all signed in. Call `close()` when done.
 */
export interface TwoCompanyWorkspace {
  owner: Page;
  ownerHeaders: Record<string, string>;
  orgSlug: string;
  a: CompanyClient;
  b: CompanyClient;
  close: () => Promise<void>;
}

async function placeInCompany(owner: Page, headers: Record<string, string>, email: string, companyName: string): Promise<string> {
  const companyRes = await owner.request.post(`${API}/companies`, { data: { name: companyName }, headers });
  expect(companyRes.ok()).toBe(true);
  const company: { id: string } = await companyRes.json();
  const contactId: string = await contactIdByEmail(owner, email);
  const res = await owner.request.put(`${API}/contacts/${contactId}`, { data: { companyId: company.id }, headers });
  expect(res.ok()).toBe(true);
  return company.id;
}

export async function createTwoCompanyWorkspace(browser: Browser, prefix: string): Promise<TwoCompanyWorkspace> {
  const { context: ownerContext, page: owner } = await createOwner(browser, `${prefix}-owner`);
  const ownerHeaders: Record<string, string> = { "x-csrf-token": await getCsrfTokenFromContext(ownerContext) };
  const clientA = await inviteAndAcceptClient(browser, owner, `${prefix}-a`);
  const clientB = await inviteAndAcceptClient(browser, owner, `${prefix}-b`);
  const companyA: string = await placeInCompany(owner, ownerHeaders, clientA.clientEmail, `Sample Company A ${prefix}`);
  const companyB: string = await placeInCompany(owner, ownerHeaders, clientB.clientEmail, `Sample Company B ${prefix}`);

  const settingsRes = await owner.request.get(`${API}/kb/settings`);
  expect(settingsRes.ok()).toBe(true);
  const settings: { orgSlug: string } = await settingsRes.json();

  const a = await signIn(browser, clientA.clientEmail, clientA.password);
  const b = await signIn(browser, clientB.clientEmail, clientB.password);

  return {
    owner,
    ownerHeaders,
    orgSlug: settings.orgSlug,
    a: { ...a, email: clientA.clientEmail, companyId: companyA },
    b: { ...b, email: clientB.clientEmail, companyId: companyB },
    close: async (): Promise<void> => {
      await a.context.close();
      await b.context.close();
      await ownerContext.close();
    },
  };
}

/** Creates an article through the API and optionally publishes it. Returns its id and slug. */
export async function createArticle(
  owner: Page,
  headers: Record<string, string>,
  data: { title: string; body: string; visibility?: string; collectionId?: string; audienceCompanyIds?: string[] },
  publish: boolean = true,
): Promise<{ id: string; slug: string }> {
  const res = await owner.request.post(`${API}/kb/articles`, { data, headers });
  expect(res.status()).toBe(201);
  const article: { id: string; slug: string } = await res.json();
  if (publish) {
    const pub = await owner.request.post(`${API}/kb/articles/${article.id}/publish`, { headers });
    expect(pub.ok()).toBe(true);
  }
  return article;
}
