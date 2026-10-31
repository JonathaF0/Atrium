import { describe, expect, it } from "bun:test";
import { dueRenewalDates, expiryDate, metadataError, parseAssetType, parseDateInput } from "./asset-fields";

describe("metadataError", () => {
  it("accepts null, undefined and flat objects of scalars", () => {
    expect(metadataError(undefined)).toBeNull();
    expect(metadataError(null)).toBeNull();
    expect(metadataError({ os: "Linux", cores: 8, managed: true })).toBeNull();
  });

  it("rejects arrays, primitives and non-plain objects", () => {
    expect(metadataError([1, 2])).toMatch(/object/);
    expect(metadataError("x")).toMatch(/object/);
    expect(metadataError(new Date())).toMatch(/plain object/);
  });

  it("rejects nested values, null values and non-finite numbers", () => {
    expect(metadataError({ a: { b: 1 } })).toMatch(/string, number or boolean/);
    expect(metadataError({ a: null })).toMatch(/string, number or boolean/);
    expect(metadataError({ a: [1] })).toMatch(/string, number or boolean/);
    expect(metadataError({ a: Number.POSITIVE_INFINITY })).toMatch(/finite/);
  });

  it("caps the number of keys", () => {
    const ok = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const tooMany = { ...ok, extra: 1 };
    expect(metadataError(ok)).toBeNull();
    expect(metadataError(tooMany)).toMatch(/at most 50 keys/);
  });

  it("caps key length, string length and total size", () => {
    expect(metadataError({ ["k".repeat(101)]: 1 })).toMatch(/keys/);
    expect(metadataError({ a: "x".repeat(1001) })).toMatch(/too long/);
    const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "x".repeat(1000)]));
    expect(metadataError(big)).toMatch(/bytes/);
  });
});

describe("parseAssetType", () => {
  it("maps canonical values and common aliases", () => {
    expect(parseAssetType("ssl_certificate")).toBe("ssl_certificate");
    expect(parseAssetType("SSL Certificate")).toBe("ssl_certificate");
    expect(parseAssetType("License")).toBe("software_license");
    expect(parseAssetType("laptop")).toBe("device");
    expect(parseAssetType("spaceship")).toBeNull();
  });
});

describe("parseDateInput", () => {
  it("parses dates and ISO timestamps, rejects the rest", () => {
    expect(parseDateInput("2026-02-28")?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(parseDateInput("2026-02-30")).toBeNull();
    expect(parseDateInput("2026-03-01T10:00:00Z")?.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(parseDateInput("03/01/2026")).toBeNull();
    expect(parseDateInput("")).toBeNull();
  });
});

describe("dueRenewalDates", () => {
  const now = new Date("2026-10-01T07:00:00Z");
  const base = { warrantyEndsAt: null, renewsAt: null, renewalNotifiedAt: null, status: "active" };

  it("selects dates inside the window that were never notified", () => {
    const due = dueRenewalDates({ ...base, renewsAt: new Date("2026-10-20T00:00:00Z") }, now, 30);
    expect(due).toEqual([{ kind: "renewal", date: new Date("2026-10-20T00:00:00Z") }]);
  });

  it("ignores dates past the window or already gone", () => {
    expect(dueRenewalDates({ ...base, renewsAt: new Date("2026-11-15T00:00:00Z") }, now, 30)).toEqual([]);
    expect(dueRenewalDates({ ...base, renewsAt: new Date("2026-09-30T00:00:00Z") }, now, 30)).toEqual([]);
  });

  it("skips a date already notified inside its window", () => {
    const asset = {
      ...base,
      warrantyEndsAt: new Date("2026-10-20T00:00:00Z"),
      renewalNotifiedAt: new Date("2026-09-25T07:00:00Z"),
    };
    expect(dueRenewalDates(asset, now, 30)).toEqual([]);
  });

  it("notifies again for a new cycle when the last notice predates the window", () => {
    const asset = {
      ...base,
      renewsAt: new Date("2026-10-20T00:00:00Z"),
      renewalNotifiedAt: new Date("2025-09-25T07:00:00Z"),
    };
    expect(dueRenewalDates(asset, now, 30)).toHaveLength(1);
  });

  it("returns both dates sorted when both are due, and nothing for retired assets", () => {
    const asset = {
      ...base,
      renewsAt: new Date("2026-10-25T00:00:00Z"),
      warrantyEndsAt: new Date("2026-10-05T00:00:00Z"),
    };
    expect(dueRenewalDates(asset, now, 30).map((d) => d.kind)).toEqual(["warranty", "renewal"]);
    expect(dueRenewalDates({ ...asset, status: "retired" }, now, 30)).toEqual([]);
  });
});

describe("expiryDate", () => {
  it("applies to licenses, certificates and domains only", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    expect(expiryDate({ type: "domain", renewsAt: d, warrantyEndsAt: null })).toEqual(d);
    expect(expiryDate({ type: "ssl_certificate", renewsAt: null, warrantyEndsAt: d })).toEqual(d);
    expect(expiryDate({ type: "device", renewsAt: d, warrantyEndsAt: d })).toBeNull();
  });
});
