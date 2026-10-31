import { describe, expect, it } from "bun:test";
import { buildStatusPage, isPubliclyVisible, type StatusSource } from "./status-page";
import { buildRss, xmlEscape } from "./rss";

const NOW = new Date("2026-10-31T12:00:00Z");
const days = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);

function src(over: Partial<StatusSource> = {}): StatusSource {
  return {
    id: "a1",
    type: "incident",
    severity: "major",
    status: "published",
    incidentState: "investigating",
    title: "Email delays",
    body: "We are looking into it.",
    impact: null,
    windowStart: null,
    windowEnd: null,
    publishedAt: days(-1),
    resolvedAt: null,
    postmortem: null,
    publicStatus: true,
    audienceType: "all",
    updates: [],
    ...over,
  };
}

describe("status page filtering", () => {
  it("only shows public announcements meant for everyone", () => {
    expect(isPubliclyVisible(src())).toBe(true);
    expect(isPubliclyVisible(src({ publicStatus: false }))).toBe(false);
    for (const audienceType of ["companies", "contracts", "assets"]) {
      expect(isPubliclyVisible(src({ audienceType }))).toBe(false);
    }
    expect(isPubliclyVisible(src({ status: "draft" }))).toBe(false);
    expect(isPubliclyVisible(src({ status: "scheduled" }))).toBe(false);
  });

  it("groups active incidents, upcoming maintenance and 30 days of history", () => {
    const page = buildStatusPage(
      [
        src({ id: "active" }),
        src({ id: "targeted", audienceType: "companies" }),
        src({ id: "private", publicStatus: false }),
        src({ id: "draft", status: "draft" }),
        src({ id: "maint", type: "maintenance", incidentState: null, windowStart: days(2), windowEnd: days(2.1) }),
        src({ id: "resolved", incidentState: "resolved", resolvedAt: days(-3) }),
        src({ id: "old", incidentState: "resolved", publishedAt: days(-60), resolvedAt: days(-45) }),
        src({ id: "expired", type: "general", status: "expired", publishedAt: days(-10) }),
      ],
      NOW,
    );
    expect(page.activeIncidents.map((i) => i.id)).toEqual(["active"]);
    expect(page.maintenance.map((i) => i.id)).toEqual(["maint"]);
    expect(page.history.map((i) => i.id).sort()).toEqual(["expired", "resolved"]);
  });

  it("never exposes audience or author fields", () => {
    const page = buildStatusPage([src({ updates: [{ state: "identified", body: "Found it", createdAt: NOW }] })], NOW);
    const item = page.activeIncidents[0] as unknown as Record<string, unknown>;
    expect(item.audienceType).toBeUndefined();
    expect(item.publicStatus).toBeUndefined();
    expect(Object.keys((item.updates as object[])[0])).toEqual(["state", "body", "createdAt"]);
  });
});

describe("RSS", () => {
  it("escapes XML special characters and strips control characters", () => {
    expect(xmlEscape(`<a href="x">Tom & 'Jerry'</a>\u0001`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;",
    );
  });

  it("produces RSS 2.0 with every user-supplied value escaped", () => {
    const page = buildStatusPage(
      [src({ title: "<script>alert(1)</script>", body: "]]> & <b>bold</b>" })],
      NOW,
    );
    const xml = buildRss(
      { title: "Sample & Co status", link: "https://status.example.com/status/sample", description: "Status <feed>" },
      page.activeIncidents,
    );
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">')).toBe(true);
    expect(xml).toContain("<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(xml).toContain("]]&gt; &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(xml).toContain("<title>Sample &amp; Co status</title>");
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("<b>");
    expect(xml).toContain(`<pubDate>${days(-1).toUTCString()}</pubDate>`);
  });

  it("renders an empty channel when nothing is public", () => {
    const xml = buildRss({ title: "t", link: "https://example.com", description: "d" }, []);
    expect(xml).toContain("<channel>");
    expect(xml).not.toContain("<item>");
  });
});
