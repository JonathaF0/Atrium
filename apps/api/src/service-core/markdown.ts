/**
 * Markdown is stored as source and rendered by the web app without raw HTML.
 * These helpers cover the server side: normalising input before it is
 * stored, and deriving plain text for excerpts, emails and search.
 */

// C0 controls except tab, newline and carriage return; plus bidi overrides used to disguise text.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

export function normalizeMarkdown(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, "").trim();
}

/** Plain text with markdown syntax and any HTML tags removed. */
export function markdownToPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ""))
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}\s+/gm, "")
    .replace(/^[ \t]{0,3}>\s?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function excerpt(md: string, length = 200): string {
  const text: string = markdownToPlainText(md).replace(/\s+/g, " ");
  return text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`;
}

export function slugify(input: string): string {
  return (
    input
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

/** Replaces {{dotted.keys}} with values; unknown keys become empty strings. */
export function fillTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}
