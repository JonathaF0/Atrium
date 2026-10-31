import type { KbArticleStatus, KbVisibility } from "@atrium/shared";

const API_URL: string = process.env.NEXT_PUBLIC_API_URL || "";

export interface KbArticleSummary {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  collectionId: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface KbReaderCollection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  order: number;
  articleCount: number;
}

export interface KbReaderArticle extends KbArticleSummary {
  body: string;
  viewCount: number;
  helpfulYes: number;
  helpfulNo: number;
  myVote: boolean | null;
  collection: { id: string; name: string; slug: string } | null;
  labels: { id: string; name: string; color: string }[];
  attachments: { id: string; filename: string; mimeType: string; sizeBytes: number }[];
}

export interface KbStaffCollection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  order: number;
  visibility: KbVisibility;
  audiences: { id: string; name: string }[];
  articleCount: number;
  childCount: number;
}

export interface KbStaffArticleRow {
  id: string;
  title: string;
  slug: string;
  status: KbArticleStatus;
  visibility: KbVisibility;
  reviewBy: string | null;
  version: number;
  viewCount: number;
  helpfulYes: number;
  helpfulNo: number;
  updatedAt: string;
  collection: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
}

export const KB_STATUS_LABELS: Record<KbArticleStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  published: "Published",
  archived: "Archived",
};

export const KB_STATUS_STYLES: Record<KbArticleStatus, string> = {
  draft: "bg-[var(--muted)] text-[var(--muted-foreground)]",
  in_review: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  published: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  archived: "bg-[var(--muted)] text-[var(--muted-foreground)] line-through",
};

/**
 * Article bodies reference attachments as `/api/kb/attachments/<id>`. Point
 * them at the API origin, or at the public route on the public help center.
 */
export function kbBodyForDisplay(body: string, publicOrgSlug?: string): string {
  const target: string = publicOrgSlug
    ? `${API_URL}/api/kb/public/${encodeURIComponent(publicOrgSlug)}/attachments/`
    : `${API_URL}/api/kb/attachments/`;
  return body.replace(/\]\(\/api\/kb\/attachments\//g, `](${target}`);
}

export function kbAttachmentUrl(id: string, publicOrgSlug?: string): string {
  return publicOrgSlug
    ? `${API_URL}/api/kb/public/${encodeURIComponent(publicOrgSlug)}/attachments/${id}`
    : `${API_URL}/api/kb/attachments/${id}`;
}

/** Collections as a depth-first list with their nesting depth, for indented trees and selects. */
export function flattenTree<T extends { id: string; parentId: string | null; order: number; name: string }>(
  items: T[],
): Array<T & { depth: number }> {
  const ids = new Set(items.map((i) => i.id));
  const children = new Map<string | null, T[]>();
  for (const item of items) {
    const parent: string | null = item.parentId && ids.has(item.parentId) ? item.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const out: Array<T & { depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    const list = (children.get(parent) ?? []).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ ...item, depth });
      walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
