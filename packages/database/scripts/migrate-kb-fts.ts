/**
 * Adds the full-text search index used by knowledge base search.
 *
 * Prisma cannot declare expression indexes, so this is applied via raw SQL
 * after `prisma db push`. Idempotent: repeat runs are a no-op.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SQL = `
  CREATE INDEX IF NOT EXISTS kb_article_fts_idx
  ON "kb_article"
  USING GIN (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body", '')))
`;

async function main(): Promise<void> {
  await prisma.$executeRawUnsafe(SQL);
  console.log("Applied full-text index: kb_article_fts_idx");
}

main()
  .catch((err) => {
    console.error("Failed to apply kb_article full-text index:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
