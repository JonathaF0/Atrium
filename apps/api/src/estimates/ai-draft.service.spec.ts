import { afterEach, describe, expect, it, mock } from "bun:test";
import { BadGatewayException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import type { ServiceSettingsService } from "../service-core";
import { AiDraftService, extractText, matchCatalog, parseAiDraft, readAiConfig } from "./ai-draft.service";

function config(values: Record<string, string>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

const ENABLED = { AI_ASSIST_ENABLED: "true", AI_PROVIDER: "anthropic", AI_API_KEY: "test-key", AI_MODEL: "test-model" };

const CATALOG = [
  {
    id: "cat-1",
    name: "Firewall setup",
    description: "Configure the firewall",
    unit: "each",
    billingType: "fixed",
    recurringInterval: null,
    rateCents: 50000,
    costCents: 20000,
    taxable: true,
  },
  {
    id: "cat-2",
    name: "Managed backup",
    description: null,
    unit: "month",
    billingType: "recurring",
    recurringInterval: "monthly",
    rateCents: 4900,
    costCents: 1500,
    taxable: true,
  },
];

const REPLY = {
  title: "Firewall and backup",
  introduction: "Set up a firewall and managed backups.",
  assumptions: ["Hardware is on site"],
  exclusions: ["Cabling"],
  lineItems: [
    { name: "Firewall setup", catalogItemId: "cat-1", quantity: 1, billingType: "fixed" },
    { name: "managed backup", quantity: 2, billingType: "recurring" },
    { name: "On-site visit", quantity: 3, unit: "hour", billingType: "hourly", unitPriceCents: 12000 },
  ],
};

function setup(cfg: Record<string, string> = ENABLED, workspaceEnabled = true) {
  const prisma = {
    catalogItem: { findMany: mock(() => Promise.resolve(CATALOG)) },
    ticket: { findFirst: mock(() => Promise.resolve({ subject: "Need a firewall" })) },
    ticketMessage: { findMany: mock(() => Promise.resolve([{ body: "Our office needs **protection**" }])) },
  };
  const settings = { get: mock(() => Promise.resolve({ aiAssistEnabled: workspaceEnabled })) };
  const service = new AiDraftService(
    prisma as unknown as PrismaService,
    settings as unknown as ServiceSettingsService,
    config(cfg),
  );
  return { prisma, settings, service };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(body: unknown, status = 200) {
  const fn = mock((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("readAiConfig", () => {
  it("is off unless explicitly enabled and fully configured", () => {
    expect(readAiConfig(config({}))).toBeNull();
    expect(readAiConfig(config({ ...ENABLED, AI_ASSIST_ENABLED: "1" }))).toBeNull();
    expect(readAiConfig(config({ ...ENABLED, AI_MODEL: "" }))).toBeNull();
    expect(readAiConfig(config({ ...ENABLED, AI_API_KEY: "" }))).toBeNull();
    expect(readAiConfig(config({ ...ENABLED, AI_PROVIDER: "other" }))).toBeNull();
  });
  it("allows a keyless OpenAI-compatible server", () => {
    const cfg = readAiConfig(config({ AI_ASSIST_ENABLED: "true", AI_PROVIDER: "openai", AI_MODEL: "local", AI_BASE_URL: "http://llm.example.com/v1/" }));
    expect(cfg).toMatchObject({ provider: "openai", apiKey: "", baseUrl: "http://llm.example.com/v1" });
  });
});

describe("parseAiDraft", () => {
  it("accepts JSON wrapped in a code fence or prose", () => {
    expect(parseAiDraft("```json\n" + JSON.stringify(REPLY) + "\n```").title).toBe("Firewall and backup");
    expect(parseAiDraft("Here you go: " + JSON.stringify(REPLY) + " Thanks").lineItems).toHaveLength(3);
  });
  it("rejects replies without the expected shape", () => {
    expect(() => parseAiDraft("no json here")).toThrow();
    expect(() => parseAiDraft(JSON.stringify({ title: "" }))).toThrow();
    expect(() => parseAiDraft(JSON.stringify({ title: "x", lineItems: [{ name: "a", billingType: "weird" }] }))).toThrow();
  });
});

describe("matchCatalog", () => {
  it("uses catalog prices by id or name and keeps guesses for unmatched lines", () => {
    const lines = matchCatalog(parseAiDraft(JSON.stringify(REPLY)).lineItems, CATALOG);
    expect(lines[0]).toMatchObject({ catalogItemId: "cat-1", unitPriceCents: 50000, fromCatalog: true });
    expect(lines[1]).toMatchObject({ catalogItemId: "cat-2", name: "Managed backup", quantity: 2, recurringInterval: "monthly" });
    expect(lines[2]).toMatchObject({ catalogItemId: null, unitPriceCents: 12000, unit: "hour", fromCatalog: false });
  });
});

describe("extractText", () => {
  it("reads both provider formats", () => {
    expect(extractText("anthropic", { content: [{ type: "text", text: "hi" }] })).toBe("hi");
    expect(extractText("openai", { choices: [{ message: { content: "hi" } }] })).toBe("hi");
    expect(extractText("openai", { choices: [] })).toBeNull();
  });
});

describe("AiDraftService.draft", () => {
  it("refuses when the server isn't configured", async () => {
    const { service } = setup({});
    await expect(service.draft("org-1", { text: "x" })).rejects.toThrow(ServiceUnavailableException);
  });

  it("refuses when the workspace toggle is off", async () => {
    const { service } = setup(ENABLED, false);
    await expect(service.draft("org-1", { text: "x" })).rejects.toThrow(ForbiddenException);
  });

  it("calls the Anthropic API and never sends catalog costs", async () => {
    const fetchMock = mockFetch({ content: [{ type: "text", text: JSON.stringify(REPLY) }] });
    const { service } = setup();
    const draft = await service.draft("org-1", { text: "We need a firewall" });
    expect(draft.title).toBe("Firewall and backup");
    expect(draft.assumptions).toBe("- Hardware is on site");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const sent = JSON.parse(init.body as string) as { model: string; messages: Array<{ content: string }> };
    expect(sent.model).toBe("test-model");
    expect(sent.messages[0].content).not.toContain("costCents");
    expect(sent.messages[0].content).not.toContain("20000");
  });

  it("uses public ticket messages only", async () => {
    mockFetch({ choices: [{ message: { content: JSON.stringify(REPLY) } }] });
    const { prisma, service } = setup({ ...ENABLED, AI_PROVIDER: "openai", AI_BASE_URL: "http://llm.example.com/v1" });
    await service.draft("org-1", { ticketId: "t-1" });
    const where = (prisma.ticketMessage.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ ticketId: "t-1", organizationId: "org-1", visibility: "public" });
  });

  it("posts to an OpenAI-compatible endpoint", async () => {
    const fetchMock = mockFetch({ choices: [{ message: { content: JSON.stringify(REPLY) } }] });
    const { service } = setup({ ...ENABLED, AI_PROVIDER: "openai", AI_BASE_URL: "http://llm.example.com/v1" });
    await service.draft("org-1", { text: "x" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://llm.example.com/v1/chat/completions");
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).authorization).toBe("Bearer test-key");
  });

  it("maps provider errors and invalid replies to 502", async () => {
    mockFetch({ error: "nope" }, 500);
    await expect(setup().service.draft("org-1", { text: "x" })).rejects.toThrow(BadGatewayException);
    mockFetch({ content: [{ type: "text", text: "not json" }] });
    await expect(setup().service.draft("org-1", { text: "x" })).rejects.toThrow(BadGatewayException);
  });

  it("maps a timeout to 502", async () => {
    globalThis.fetch = mock(() => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))) as unknown as typeof fetch;
    await expect(setup().service.draft("org-1", { text: "x" })).rejects.toThrow(/too long/);
  });
});
