import type { StatusItem } from "./status-page";

/** Escapes text for XML element content and attribute values. Drops characters XML 1.0 forbids. */
export function xmlEscape(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface RssChannel {
  title: string;
  link: string;
  description: string;
}

/** RSS 2.0 feed of status page items. Every value goes through xmlEscape; nothing is CDATA. */
export function buildRss(channel: RssChannel, items: StatusItem[]): string {
  const entries = items
    .map((item) => {
      const date = item.updates.at(-1)?.createdAt ?? item.resolvedAt ?? item.publishedAt;
      const link = `${channel.link}#${encodeURIComponent(item.id)}`;
      const latest = item.updates.at(-1)?.body;
      const description = latest ? `${latest}\n\n${item.body}` : item.body;
      return [
        "    <item>",
        `      <title>${xmlEscape(item.title)}</title>`,
        `      <link>${xmlEscape(link)}</link>`,
        `      <guid isPermaLink="false">${xmlEscape(`${item.id}:${item.updates.length}`)}</guid>`,
        `      <category>${xmlEscape(item.type)}</category>`,
        date ? `      <pubDate>${new Date(date).toUTCString()}</pubDate>` : null,
        `      <description>${xmlEscape(description)}</description>`,
        "    </item>",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    })
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${xmlEscape(channel.title)}</title>`,
    `    <link>${xmlEscape(channel.link)}</link>`,
    `    <description>${xmlEscape(channel.description)}</description>`,
    entries,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}
