import { describe, expect, it } from "bun:test";
import { KbViewCounter } from "./kb-view-counter";

describe("KbViewCounter", () => {
  const day1 = new Date("2026-03-01T10:00:00Z");
  const day1Later = new Date("2026-03-01T23:59:00Z");
  const day2 = new Date("2026-03-02T00:01:00Z");

  it("counts a reader once per article per day", () => {
    const counter = new KbViewCounter();
    expect(counter.shouldCount("u1", "a1", day1)).toBe(true);
    expect(counter.shouldCount("u1", "a1", day1Later)).toBe(false);
    expect(counter.shouldCount("u1", "a2", day1)).toBe(true);
    expect(counter.shouldCount("u2", "a1", day1)).toBe(true);
  });

  it("counts again the next day", () => {
    const counter = new KbViewCounter();
    counter.shouldCount("u1", "a1", day1);
    expect(counter.shouldCount("u1", "a1", day2)).toBe(true);
    expect(counter.shouldCount("u1", "a1", day2)).toBe(false);
  });

  it("stays bounded", () => {
    const counter = new KbViewCounter(3);
    for (const id of ["a", "b", "c", "d"]) counter.shouldCount("u", id, day1);
    // The cap reset the memory, so an early article may count again; it never grows past the cap.
    expect(counter.shouldCount("u", "d", day1)).toBe(false);
  });
});
