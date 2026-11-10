import { afterEach, describe, expect, it, mock } from "bun:test";
import { BadGatewayException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ReplySuggestionService, parseSuggestion, redactContactDetails } from "./reply-suggestion.service";

const ORG = "org1";
const AI_ENV = {
  AI_ASSIST_ENABLED: "true",
  AI_PROVIDER: "anthropic",
  AI_API_KEY: "test-key",
  AI_MODEL: "test-model",
  WEB_URL: "https://portal.example.com",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function providerReplies(text: string) {
  const fetchMock = mock(async (_url: string, init: { body: string }) => {
    void init;
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function build(env: Record<string, string> = AI_ENV, opts: { workspaceOn?: boolean; ticket?: unknown } = {}) {
  const prisma = {
    ticket: {
      findFirst: mock(async () =>
        opts.ticket === undefined ? { id: "t1", subject: "VPN keeps dropping", companyId: "co1", category: { name: "Network" } } : opts.ticket,
      ),
    },
    ticketMessage: {
      findMany: mock(async () => [
        // Newest first, as queried.
        { body: "Did you try restarting?", authorUserId: "staff1", source: "staff", authorName: "Alex" },
        { body: "My VPN drops every hour. Reach me at sam@example.com or +1 555 010 0199.", authorUserId: "client1", source: "portal", authorName: "Sam" },
      ]),
    },
    member: { findMany: mock(async () => [{ userId: "staff1" }]) },
    kbArticle: {
      findMany: mock(async () => [
        { id: "a1", title: "Fix VPN disconnects", slug: "fix-vpn-disconnects", body: "Update the VPN client to the latest version." },
        { id: "a2", title: "Choosing a password", slug: "choosing-a-password", body: "Use a passphrase." },
      ]),
    },
  };
  const settings = { get: mock(async () => ({ aiAssistEnabled: opts.workspaceOn ?? true })) };
  const reader = { search: mock(async () => [{ id: "a1" }, { id: "a2" }]) };
  const service = new ReplySuggestionService(prisma as never, settings as never, reader as never, new ConfigService(env));
  return { service, prisma, reader };
}

describe("ReplySuggestionService.suggest", () => {
  it("drafts a reply from public messages and client-visible articles, linking only the ones it used", async () => {
    const fetchMock = providerReplies(JSON.stringify({ reply: "Please update your VPN client.", articleIds: ["a1"] }));
    const s = build();
    const res = await s.service.suggest(ORG, "t1");

    expect(res.body).toBe("Please update your VPN client.\n\n- [Fix VPN disconnects](https://portal.example.com/portal/kb/fix-vpn-disconnects)");
    expect(res.articles).toEqual([{ id: "a1", title: "Fix VPN disconnects", url: "https://portal.example.com/portal/kb/fix-vpn-disconnects" }]);

    const where = (s.prisma.ticketMessage.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ ticketId: "t1", organizationId: ORG, visibility: "public" });
    const [, reader, , searchOpts] = s.reader.search.mock.calls[0] as unknown as [string, unknown, string, Record<string, unknown>];
    expect(reader).toEqual({ kind: "client", companyId: "co1" });
    expect(searchOpts).toMatchObject({ publishedOnly: true });

    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as {
      model: string;
      messages: { content: string }[];
    };
    const prompt = sent.messages[0].content;
    expect(sent.model).toBe("test-model");
    expect(prompt).toContain("Client:\nMy VPN drops every hour.");
    expect(prompt).toContain("Support:\nDid you try restarting?");
    expect(prompt.indexOf("Client:")).toBeLessThan(prompt.indexOf("Support:"));
    expect(prompt).not.toContain("sam@example.com");
    expect(prompt).not.toContain("555");
  });

  it("refuses when AI assist isn't configured on the server", async () => {
    const s = build({ WEB_URL: "https://portal.example.com" });
    await expect(s.service.suggest(ORG, "t1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("refuses when the workspace has AI assist turned off", async () => {
    const s = build(AI_ENV, { workspaceOn: false });
    await expect(s.service.suggest(ORG, "t1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("404s for a ticket outside the workspace", async () => {
    const s = build(AI_ENV, { ticket: null });
    await expect(s.service.suggest(ORG, "t1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reports an unusable provider answer as a bad gateway", async () => {
    providerReplies("Sure! Here's a reply: please restart.");
    const s = build();
    await expect(s.service.suggest(ORG, "t1")).rejects.toBeInstanceOf(BadGatewayException);
  });

  it("status reflects both the server config and the workspace switch", async () => {
    expect(await build().service.status(ORG)).toEqual({ available: true });
    expect(await build(AI_ENV, { workspaceOn: false }).service.status(ORG)).toEqual({ available: false });
    expect(await build({}).service.status(ORG)).toEqual({ available: false });
  });
});

describe("parseSuggestion", () => {
  it("reads JSON wrapped in a code fence", () => {
    expect(parseSuggestion('```json\n{"reply":"Hi","articleIds":[]}\n```')).toEqual({ reply: "Hi", articleIds: [] });
  });

  it("defaults missing article ids and rejects an empty reply", () => {
    expect(parseSuggestion('{"reply":"Hi"}')).toEqual({ reply: "Hi", articleIds: [] });
    expect(() => parseSuggestion('{"reply":""}')).toThrow();
  });
});

describe("redactContactDetails", () => {
  it("masks emails and phone numbers", () => {
    expect(redactContactDetails("Mail sam@example.com or call (555) 010-0199")).toBe("Mail [email] or call [phone]");
  });
});
