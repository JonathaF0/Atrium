import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { KB_ARTICLE_STATUSES } from "@atrium/shared";
import { contentChanged, isVersionedStatus, nextStatus } from "./kb-workflow";
import type { KbWorkflowAction } from "./kb-workflow";

describe("kb article workflow", () => {
  const table: Record<KbWorkflowAction, Record<string, string | null>> = {
    submit: { draft: "in_review", in_review: null, published: null, archived: null },
    publish: { draft: "published", in_review: "published", published: null, archived: null },
    unpublish: { draft: null, in_review: "draft", published: "draft", archived: "draft" },
    archive: { draft: "archived", in_review: "archived", published: "archived", archived: null },
  };

  for (const action of Object.keys(table) as KbWorkflowAction[]) {
    for (const from of KB_ARTICLE_STATUSES) {
      const to = table[action][from];
      it(`${action} from ${from} → ${to ?? "rejected"}`, () => {
        if (to) expect(nextStatus(from, action)).toBe(to as never);
        else expect(() => nextStatus(from, action)).toThrow(BadRequestException);
      });
    }
  }

  it("rejects unknown actions and statuses", () => {
    expect(() => nextStatus("draft", "delete" as KbWorkflowAction)).toThrow(BadRequestException);
    expect(() => nextStatus("weird", "publish")).toThrow(BadRequestException);
  });

  it("only published and in-review edits are versioned", () => {
    expect(isVersionedStatus("published")).toBe(true);
    expect(isVersionedStatus("in_review")).toBe(true);
    expect(isVersionedStatus("draft")).toBe(false);
    expect(isVersionedStatus("archived")).toBe(false);
  });

  it("detects content changes in title or body only", () => {
    const before = { title: "A", body: "x" };
    expect(contentChanged(before, {})).toBe(false);
    expect(contentChanged(before, { title: "A", body: "x" })).toBe(false);
    expect(contentChanged(before, { title: "B" })).toBe(true);
    expect(contentChanged(before, { body: "y" })).toBe(true);
  });
});
