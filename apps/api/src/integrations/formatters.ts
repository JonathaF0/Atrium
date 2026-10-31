import type { IntegrationType } from "@atrium/shared";
import type { IntegrationPayload } from "./integration-payload";
import { eventColor, eventFacts, eventLabel } from "./event-format";

const DETAIL_LIMIT = 1000;

function truncate(text: string, limit: number = DETAIL_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Slack treats <...> as links and mentions, so user text must be escaped. */
function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function joinParts(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function slackBody(p: IntegrationPayload): object {
  const context: string = joinParts([eventLabel(p.event), p.project?.name, p.actor?.name, p.workspace.name]);
  const blocks: object[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${slackEscape(p.title)}*` } },
  ];
  if (p.detail) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: slackEscape(truncate(p.detail)) } });
  }
  const facts = eventFacts(p.data);
  if (facts.length > 0) {
    blocks.push({
      type: "section",
      fields: facts.map((f) => ({ type: "mrkdwn", text: `*${slackEscape(f.name)}*\n${slackEscape(f.value)}` })),
    });
  }
  blocks.push(
    { type: "context", elements: [{ type: "mrkdwn", text: slackEscape(context) }] },
    {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "View in Atrium" }, url: p.url }],
    },
  );
  return { text: slackEscape(p.title), blocks };
}

function discordBody(p: IntegrationPayload): object {
  const facts = eventFacts(p.data);
  return {
    username: "Atrium",
    // Client-written text must never turn into @everyone or role pings.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: truncate(p.title, 256),
        url: p.url,
        description: p.detail ? truncate(p.detail) : undefined,
        color: eventColor(p.event),
        fields: facts.length > 0 ? facts.map((f) => ({ name: truncate(f.name, 256), value: truncate(f.value, 1024), inline: true })) : undefined,
        author: p.actor ? { name: truncate(p.actor.name, 256) } : undefined,
        footer: { text: truncate(joinParts([eventLabel(p.event), p.project?.name, p.workspace.name]), 2048) },
        timestamp: p.createdAt,
      },
    ],
  };
}

export function formatBody(type: IntegrationType, payload: IntegrationPayload): string {
  if (type === "slack") return JSON.stringify(slackBody(payload));
  if (type === "discord") return JSON.stringify(discordBody(payload));
  return JSON.stringify(payload);
}
