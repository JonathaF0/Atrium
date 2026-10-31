import * as z from "zod/v4";
import { BadRequestException } from "@nestjs/common";
import { defineTool } from "../tool-kit";
import type { McpTool } from "../tool-kit";
import { isPrivilegedRole } from "../../common";
import type { KbReaderService } from "../../kb/kb-reader.service";
import type { KbArticlesService } from "../../kb/kb-articles.service";
import type { KbCollectionsService } from "../../kb/kb-collections.service";
import type { KbReader } from "../../kb/kb-visibility";

export function kbTools(deps: {
  reader: Pick<KbReaderService, "search">;
  articles: Pick<KbArticlesService, "get" | "getBySlug">;
  collections: Pick<KbCollectionsService, "list">;
}): McpTool[] {
  const { reader, articles, collections } = deps;
  return [
    defineTool({
      name: "search_kb_articles",
      description:
        "Full-text search of published knowledge base articles, best match first. With includeInternal=false, only articles every portal client can read are returned.",
      inputSchema: z.object({
        q: z.string().trim().min(1).max(200),
        includeInternal: z.boolean().default(true).describe("Include staff-only and company-restricted articles"),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      handler: async (input, actor) => {
        const staff: boolean = input.includeInternal && isPrivilegedRole(actor.member.role);
        const as: KbReader = staff ? { kind: "staff" } : { kind: "client", companyId: null };
        return reader.search(actor.organization.id, as, input.q, { limit: input.limit, publishedOnly: true });
      },
    }),
    defineTool({
      name: "get_kb_article",
      description:
        "Gets one knowledge base article (any status) by id or slug, with its markdown body, visibility and effective visibility.",
      inputSchema: z.object({
        id: z.string().max(64).optional(),
        slug: z.string().max(80).optional(),
      }),
      handler: async (input, actor) => {
        if (input.id) return articles.get(actor.organization.id, input.id);
        if (input.slug) return articles.getBySlug(actor.organization.id, input.slug);
        throw new BadRequestException("Pass an id or a slug");
      },
    }),
    defineTool({
      name: "list_kb_collections",
      description: "Lists knowledge base collections with their visibility, parent and article counts.",
      inputSchema: z.object({}),
      handler: async (_input, actor) => collections.list(actor.organization.id),
    }),
  ];
}
