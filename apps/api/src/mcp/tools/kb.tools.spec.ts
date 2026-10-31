import { describe, expect, it, mock } from "bun:test";
import { kbTools } from "./kb.tools";
import { runTool } from "../tool-kit";
import type { Actor } from "../../common";

const admin = { user: { id: "u1" }, organization: { id: "org1" }, member: { role: "admin" } } as unknown as Actor;
const member = { user: { id: "u2" }, organization: { id: "org1" }, member: { role: "member" } } as unknown as Actor;

function build() {
  const reader = { search: mock((..._a: unknown[]) => Promise.resolve([])) };
  const articles = {
    get: mock((..._a: unknown[]) => Promise.resolve({ id: "a1", body: "# Hi" })),
    getBySlug: mock((..._a: unknown[]) => Promise.resolve({ id: "a1", body: "# Hi" })),
  };
  const collections = { list: mock((..._a: unknown[]) => Promise.resolve([])) };
  const tools = kbTools({ reader: reader as never, articles: articles as never, collections: collections as never });
  const get = (name: string) => tools.find((t) => t.name === name)!;
  return { reader, articles, collections, get };
}

describe("kb tools", () => {
  it("search includes internal articles for staff by default", async () => {
    const { reader, get } = build();
    const tool = get("search_kb_articles");
    await runTool(tool, tool.inputSchema.parse({ q: "vpn" }), admin);
    expect(reader.search).toHaveBeenCalledWith("org1", { kind: "staff" }, "vpn", { limit: 10, publishedOnly: true });
  });

  it("search can be limited to what every client can read", async () => {
    const { reader, get } = build();
    const tool = get("search_kb_articles");
    await runTool(tool, tool.inputSchema.parse({ q: "vpn", includeInternal: false }), admin);
    expect(reader.search.mock.calls[0][1]).toEqual({ kind: "client", companyId: null });
  });

  it("a non-staff actor never gets the staff view", async () => {
    const { reader, get } = build();
    const tool = get("search_kb_articles");
    await runTool(tool, tool.inputSchema.parse({ q: "vpn" }), member);
    expect(reader.search.mock.calls[0][1]).toEqual({ kind: "client", companyId: null });
  });

  it("search rejects an empty query", () => {
    expect(build().get("search_kb_articles").inputSchema.safeParse({ q: "  " }).success).toBe(false);
  });

  it("get_kb_article looks up by id or slug within the org", async () => {
    const { articles, get } = build();
    await runTool(get("get_kb_article"), { id: "a1" }, admin);
    await runTool(get("get_kb_article"), { slug: "reset-password" }, admin);
    expect(articles.get).toHaveBeenCalledWith("org1", "a1");
    expect(articles.getBySlug).toHaveBeenCalledWith("org1", "reset-password");
    const result = await runTool(get("get_kb_article"), {}, admin);
    expect(result.isError).toBe(true);
  });

  it("list_kb_collections is scoped to the org", async () => {
    const { collections, get } = build();
    await runTool(get("list_kb_collections"), {}, admin);
    expect(collections.list).toHaveBeenCalledWith("org1");
  });
});
