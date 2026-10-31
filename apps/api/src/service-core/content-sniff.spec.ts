import { describe, expect, it } from "bun:test";
import { mimeMatchesContent, sniffMime } from "./content-sniff";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = Buffer.from("%PDF-1.7\n");
const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]);

describe("sniffMime", () => {
  it("recognises common signatures", () => {
    expect(sniffMime(png)).toBe("image/png");
    expect(sniffMime(pdf)).toBe("application/pdf");
    expect(sniffMime(exe)).toBe("application/x-msdownload");
    expect(sniffMime(Buffer.from("  <!DOCTYPE html><html>"))).toBe("text/html");
    expect(sniffMime(Buffer.from("<svg xmlns=..."))).toBe("image/svg+xml");
    expect(sniffMime(Buffer.from("hello, world"))).toBeNull();
  });
});

describe("mimeMatchesContent", () => {
  it("accepts a file whose content matches its type", () => {
    expect(mimeMatchesContent("image/png", png)).toBe(true);
    expect(mimeMatchesContent("application/pdf", pdf)).toBe(true);
    expect(mimeMatchesContent("application/vnd.openxmlformats-officedocument.wordprocessingml.document", zip)).toBe(true);
    expect(mimeMatchesContent("text/plain", Buffer.from("log line"))).toBe(true);
  });

  it("refuses a renamed executable or a mismatched image", () => {
    expect(mimeMatchesContent("image/png", exe)).toBe(false);
    expect(mimeMatchesContent("application/octet-stream", exe)).toBe(false);
    expect(mimeMatchesContent("image/jpeg", pdf)).toBe(false);
  });

  it("refuses HTML and SVG whatever they claim to be", () => {
    expect(mimeMatchesContent("text/plain", Buffer.from("<html><script>alert(1)</script>"))).toBe(false);
    expect(mimeMatchesContent("image/png", Buffer.from("<svg onload=alert(1)>"))).toBe(false);
  });

  it("refuses unrecognised binary content declared as an image", () => {
    expect(mimeMatchesContent("image/png", Buffer.from("plain text"))).toBe(false);
  });
});
