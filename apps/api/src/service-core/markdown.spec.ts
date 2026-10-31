import { describe, expect, it } from "bun:test";
import { excerpt, fillTemplate, markdownToPlainText, normalizeMarkdown, slugify } from "./markdown";

describe("normalizeMarkdown", () => {
  it("normalises newlines and strips control and bidi characters", () => {
    expect(normalizeMarkdown("  a\r\nb\u0000c‮d  ")).toBe("a\nbcd");
  });
});

describe("markdownToPlainText", () => {
  it("removes markdown syntax and HTML", () => {
    const md = "# Title\n\nSome **bold** and [a link](https://example.com) <script>x</script>\n\n- item";
    expect(markdownToPlainText(md)).toBe("Title\n\nSome bold and a link x\n\n• item");
  });
});

describe("excerpt", () => {
  it("truncates on length with an ellipsis", () => {
    expect(excerpt("word ".repeat(100), 20).length).toBeLessThanOrEqual(20);
    expect(excerpt("short")).toBe("short");
  });
});

describe("slugify", () => {
  it("makes URL-safe slugs", () => {
    expect(slugify("Reset your VPN password!")).toBe("reset-your-vpn-password");
    expect(slugify("Ünïcödé")).toBe("unicode");
    expect(slugify("***")).toBe("untitled");
  });
});

describe("fillTemplate", () => {
  it("fills known variables and blanks unknown ones", () => {
    expect(fillTemplate("Hi {{requester.firstName}}, re {{ ticket.number }} {{nope}}", {
      "requester.firstName": "Sam",
      "ticket.number": "TKT-1001",
    })).toBe("Hi Sam, re TKT-1001 ");
  });
});
