import { describe, expect, it } from "bun:test";
import { ConfigService } from "@nestjs/config";
import { UploadScanner, parseClamdReply } from "./upload-scanner";

describe("parseClamdReply", () => {
  it("reads clean, infected and unexpected replies", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ status: "clean" });
    expect(parseClamdReply("stream: Eicar-Test-Signature FOUND\0")).toEqual({
      status: "infected",
      signature: "Eicar-Test-Signature",
    });
    expect(parseClamdReply("INSTREAM size limit exceeded. ERROR")).toEqual({ status: "error" });
  });
});

describe("UploadScanner", () => {
  it("skips scanning when no ClamAV host is configured", async () => {
    const scanner = new UploadScanner(new ConfigService({}));
    expect(scanner.enabled).toBe(false);
    expect(await scanner.scanFile("/nonexistent")).toEqual({ status: "skipped" });
  });

  it("reports an error (not clean) when the scanner is unreachable", async () => {
    const scanner = new UploadScanner(new ConfigService({ CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: "1", CLAMAV_TIMEOUT_MS: "500" }));
    expect((await scanner.scanFile("/nonexistent")).status).toBe("error");
  });
});
