import { BadRequestException } from "@nestjs/common";
import type { KbArticleStatus } from "@atrium/shared";

export type KbWorkflowAction = "submit" | "publish" | "unpublish" | "archive";

/**
 * Article workflow. There is no separate approver role: any owner or admin may
 * publish, including their own article, so "in review" is a signal to
 * colleagues rather than a gate.
 */
export const KB_TRANSITIONS: Record<KbWorkflowAction, { from: KbArticleStatus[]; to: KbArticleStatus }> = {
  submit: { from: ["draft"], to: "in_review" },
  publish: { from: ["draft", "in_review"], to: "published" },
  unpublish: { from: ["published", "in_review", "archived"], to: "draft" },
  archive: { from: ["draft", "in_review", "published"], to: "archived" },
};

export function nextStatus(current: string, action: KbWorkflowAction): KbArticleStatus {
  const rule = KB_TRANSITIONS[action];
  if (!rule) throw new BadRequestException("Unknown action");
  if (!(rule.from as string[]).includes(current)) {
    throw new BadRequestException(`Cannot ${action} an article that is ${current.replace("_", " ")}`);
  }
  return rule.to;
}

/** Edits to these statuses are versioned: each content change becomes a new revision. */
export function isVersionedStatus(status: string): boolean {
  return status === "published" || status === "in_review";
}

export function contentChanged(
  before: { title: string; body: string },
  after: { title?: string; body?: string },
): boolean {
  return (after.title !== undefined && after.title !== before.title) || (after.body !== undefined && after.body !== before.body);
}
