import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { ServiceSettingsService, markdownToPlainText } from "../service-core";
import { completeText, readAiConfig } from "../ai/ai-client";
import { KbReaderService } from "../kb/kb-reader.service";

const MAX_MESSAGES = 20;
const MAX_THREAD_CHARS = 12_000;
const MAX_ARTICLES = 4;
const MAX_ARTICLE_CHARS = 3_000;

const SYSTEM_PROMPT = [
  "You draft replies for an IT support team answering a client's ticket.",
  "Write the next public reply from the team to the client, in plain markdown, ready for a person to review and edit.",
  "Be specific and concise; give numbered steps when the client has to do something.",
  "Use the help articles provided when they answer the question, and only those: never invent links, settings or facts.",
  "If you are missing information, ask the client for it instead of guessing.",
  "Do not sign the reply, add a subject line, or mention that you are an AI.",
  "Answer with JSON only, no prose around it: {\"reply\": string, \"articleIds\": string[]}",
  "where articleIds lists the ids of the provided articles your reply relies on (possibly none).",
].join("\n");

const suggestionSchema = z.object({
  reply: z.string().trim().min(1).max(20_000),
  articleIds: z.array(z.string().max(50)).max(20).default([]),
});

/** Extracts the JSON object from a model reply, tolerating code fences or stray text around it. */
export function parseSuggestion(text: string): z.infer<typeof suggestionSchema> {
  const start: number = text.indexOf("{");
  const end: number = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in the reply");
  return suggestionSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/** Removes email addresses and phone-like numbers before text leaves the workspace. */
export function redactContactDetails(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+?\(?\d[\d\s().-]{7,}\d/g, "[phone]");
}

export interface ReplySuggestion {
  body: string;
  articles: { id: string; title: string; url: string }[];
}

/**
 * Drafts a reply to a ticket with the configured AI provider, grounded in the
 * help articles the requester is allowed to read. Nothing is sent or stored:
 * the draft goes into the staff composer for a person to edit.
 */
@Injectable()
export class ReplySuggestionService {
  private readonly logger = new Logger(ReplySuggestionService.name);
  private readonly webUrl: string;

  constructor(
    private prisma: PrismaService,
    private settings: ServiceSettingsService,
    private reader: KbReaderService,
    private config: ConfigService,
  ) {
    this.webUrl = config.get<string>("WEB_URL", "http://localhost:3000").replace(/\/+$/, "");
  }

  async status(orgId: string): Promise<{ available: boolean }> {
    const configured: boolean = readAiConfig(this.config) !== null;
    return { available: configured && (await this.settings.get(orgId)).aiAssistEnabled };
  }

  async suggest(orgId: string, ticketId: string): Promise<ReplySuggestion> {
    const cfg = readAiConfig(this.config);
    if (!cfg) throw new ServiceUnavailableException("AI assist is not configured on this server");
    if (!(await this.settings.get(orgId)).aiAssistEnabled) {
      throw new ForbiddenException("AI assist is turned off for this workspace");
    }

    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, organizationId: orgId },
      select: { id: true, subject: true, companyId: true, category: { select: { name: true } } },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    // Public messages only: internal notes never leave the workspace.
    const messages = await this.prisma.ticketMessage.findMany({
      where: { ticketId, organizationId: orgId, visibility: "public" },
      orderBy: { createdAt: "desc" },
      take: MAX_MESSAGES,
      select: { body: true, authorUserId: true, source: true, authorName: true },
    });
    const staffIds = new Set<string>(
      (
        await this.prisma.member.findMany({
          where: { organizationId: orgId, role: { in: ["owner", "admin"] } },
          select: { userId: true },
        })
      ).map((m) => m.userId),
    );
    const thread: string = messages
      .reverse()
      .map((m) => {
        const who: string = m.authorUserId && staffIds.has(m.authorUserId) ? "Support" : "Client";
        return `${who}:\n${markdownToPlainText(m.body)}`;
      })
      .join("\n\n");

    // Only articles the requester could open themselves, so the reply never points at a staff runbook.
    const query: string = [ticket.subject, messages.at(-1) ? markdownToPlainText(messages.at(-1)!.body).slice(0, 300) : ""]
      .join(" ")
      .slice(0, 200);
    const hits = await this.reader.search(orgId, { kind: "client", companyId: ticket.companyId }, query, {
      limit: MAX_ARTICLES,
      mode: "suggest",
      publishedOnly: true,
    });
    const bodies = hits.length
      ? await this.prisma.kbArticle.findMany({
          where: { id: { in: hits.map((h) => h.id) }, organizationId: orgId },
          select: { id: true, title: true, slug: true, body: true },
        })
      : [];

    const articlesForPrompt = bodies.map((a) => ({
      id: a.id,
      title: a.title,
      text: markdownToPlainText(a.body).slice(0, MAX_ARTICLE_CHARS),
    }));
    const user: string = [
      `Ticket subject: ${ticket.subject}`,
      ticket.category ? `Category: ${ticket.category.name}` : "",
      `Help articles (JSON):\n${JSON.stringify(articlesForPrompt)}`,
      `Conversation so far, oldest first:\n"""\n${redactContactDetails(thread).slice(-MAX_THREAD_CHARS)}\n"""`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const text: string = await completeText(cfg, { system: SYSTEM_PROMPT, user, maxTokens: 2048 });
    let parsed: z.infer<typeof suggestionSchema>;
    try {
      parsed = parseSuggestion(text);
    } catch {
      this.logger.warn("Reply suggestion was not valid JSON for the expected shape");
      throw new BadGatewayException("The AI provider returned an unusable reply. Try again.");
    }

    const cited = bodies.filter((a) => parsed.articleIds.includes(a.id));
    const articles = cited.map((a) => ({ id: a.id, title: a.title, url: `${this.webUrl}/portal/kb/${a.slug}` }));
    const links: string = articles.length
      ? `\n\n${articles.map((a) => `- [${a.title.replace(/[[\]]/g, "")}](${a.url})`).join("\n")}`
      : "";
    return { body: `${parsed.reply.trim()}${links}`, articles };
  }
}
