/**
 * Loads the generic sample content (ticket categories, SLA policy, service
 * catalog, knowledge base drafts, canned responses, announcement templates)
 * into one workspace or all of them.
 *
 *   bun run db:seed:samples -- --org <slug-or-id>
 *   bun run db:seed:samples -- --all
 *
 * Idempotent: content that already exists (by name, title or slug) is skipped.
 */
import { PrismaClient } from "@prisma/client";
import { seedSampleContent } from "../src/sample-content";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  const all: boolean = args.includes("--all");
  const orgArg: string | undefined = args[args.indexOf("--org") + 1];
  if (!all && (!args.includes("--org") || !orgArg)) {
    console.error("Usage: bun run db:seed:samples -- --org <slug-or-id> | --all");
    process.exit(1);
  }

  const orgs = await prisma.organization.findMany({
    where: all ? {} : { OR: [{ id: orgArg }, { slug: orgArg }] },
    select: { id: true, name: true },
  });
  if (orgs.length === 0) {
    console.log(all ? "No workspaces yet; create one, then run this again." : `No workspace matches "${orgArg}".`);
    return;
  }
  for (const org of orgs) {
    const { created } = await seedSampleContent(prisma, org.id);
    const summary: string = Object.entries(created).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing new";
    console.log(`${org.name}: ${summary}`);
  }
}

main()
  .catch((err) => {
    console.error("Failed to load sample content:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
