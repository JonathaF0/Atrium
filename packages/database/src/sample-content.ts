import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_BUSINESS_SCHEDULE,
  DEFAULT_SLA_TARGETS,
  DEFAULT_TICKET_CATEGORIES,
} from "@atrium/shared";

/**
 * Generic starter content for an IT services workspace: ticket categories, an
 * SLA policy, a service catalog, knowledge base drafts, canned responses and
 * announcement templates. Everything is labelled as sample content and can be
 * edited or deleted. Safe to run repeatedly: existing rows (matched by name,
 * title or slug) are left alone.
 */

const SAMPLE_NOTE = "Sample content. Edit or delete it to suit your services.";

const CATALOG_ITEMS: {
  name: string;
  description: string;
  category: string;
  unit: string;
  billingType: "hourly" | "fixed" | "recurring";
  recurringInterval?: "monthly";
  rateCents: number;
  costCents?: number;
}[] = [
  { name: "Remote support", description: "Remote troubleshooting and administration.", category: "Labor", unit: "hour", billingType: "hourly", rateCents: 12500 },
  { name: "On-site support", description: "Technician visit, billed per hour on site.", category: "Labor", unit: "hour", billingType: "hourly", rateCents: 15000 },
  { name: "Project engineering", description: "Planning and implementation work for projects.", category: "Labor", unit: "hour", billingType: "hourly", rateCents: 16500 },
  { name: "Workstation setup", description: "Image, configure and enroll one workstation.", category: "Deployment", unit: "each", billingType: "fixed", rateCents: 25000 },
  { name: "User account onboarding", description: "Create accounts, mailbox and access for one user.", category: "Deployment", unit: "each", billingType: "fixed", rateCents: 9500 },
  { name: "Network assessment", description: "Review of network layout, devices and security posture with a written report.", category: "Assessments", unit: "each", billingType: "fixed", rateCents: 150000 },
  { name: "Security assessment", description: "Baseline security review with prioritised recommendations.", category: "Assessments", unit: "each", billingType: "fixed", rateCents: 200000 },
  { name: "Managed workstation", description: "Monitoring, patching and support for one workstation.", category: "Managed services", unit: "device", billingType: "recurring", recurringInterval: "monthly", rateCents: 4500 },
  { name: "Managed server", description: "Monitoring, patching and support for one server.", category: "Managed services", unit: "device", billingType: "recurring", recurringInterval: "monthly", rateCents: 15000 },
  { name: "Backup monitoring", description: "Daily backup checks and restore testing.", category: "Managed services", unit: "month", billingType: "recurring", recurringInterval: "monthly", rateCents: 7500 },
  { name: "Onboarding fee", description: "One-time setup to bring a new client under management.", category: "Managed services", unit: "each", billingType: "fixed", rateCents: 75000 },
];

const BUNDLES: { name: string; description: string; items: { name: string; quantity: number; optional?: boolean }[] }[] = [
  {
    name: "New workstation deployment",
    description: "Set up a new computer for a user.",
    items: [
      { name: "Workstation setup", quantity: 1 },
      { name: "User account onboarding", quantity: 1, optional: true },
      { name: "Managed workstation", quantity: 1, optional: true },
    ],
  },
  {
    name: "Network assessment",
    description: "Assessment with an on-site visit.",
    items: [
      { name: "Network assessment", quantity: 1 },
      { name: "On-site support", quantity: 2 },
    ],
  },
  {
    name: "Managed services onboarding",
    description: "Bring a new client under monthly management.",
    items: [
      { name: "Onboarding fee", quantity: 1 },
      { name: "Project engineering", quantity: 4 },
      { name: "Managed workstation", quantity: 10 },
      { name: "Managed server", quantity: 1 },
      { name: "Backup monitoring", quantity: 1, optional: true },
    ],
  },
];

const KB_COLLECTIONS: { name: string; slug: string; description: string; visibility: string }[] = [
  { name: "Getting started", slug: "getting-started", description: "How to get help and use this portal.", visibility: "clients" },
  { name: "Accounts and passwords", slug: "accounts-and-passwords", description: "Signing in, passwords and multi-factor authentication.", visibility: "clients" },
  { name: "Security", slug: "security", description: "Staying safe online.", visibility: "clients" },
  { name: "Staff runbooks", slug: "staff-runbooks", description: "Internal procedures. Not visible to clients.", visibility: "internal" },
];

const KB_ARTICLES: { collection: string; title: string; slug: string; body: string }[] = [
  {
    collection: "getting-started",
    title: "How to request support",
    slug: "how-to-request-support",
    body: `Open **Support** in the portal and choose **New ticket**. Pick the category that fits best, describe what happened and attach screenshots if you can.

- Include when the problem started and who is affected.
- For anything urgent, set the impact and urgency to high.
- You can also email the support address; replies are added to the same ticket.

You will get an email when we reply or the ticket status changes.

> ${SAMPLE_NOTE}`,
  },
  {
    collection: "accounts-and-passwords",
    title: "Set up multi-factor authentication",
    slug: "set-up-multi-factor-authentication",
    body: `Multi-factor authentication (MFA) protects your account even if your password is stolen.

1. Install an authenticator app on your phone.
2. Sign in to your account settings and choose **Enable two-factor authentication**.
3. Scan the QR code and enter the six-digit code.
4. Store your backup codes somewhere safe.

> ${SAMPLE_NOTE}`,
  },
  {
    collection: "accounts-and-passwords",
    title: "Choosing a strong password",
    slug: "choosing-a-strong-password",
    body: `Use a long passphrase of four or more unrelated words, a different password for every service, and a password manager to remember them.

Never share passwords by email or chat. Our staff will never ask for your password.

> ${SAMPLE_NOTE}`,
  },
  {
    collection: "security",
    title: "How to spot a phishing email",
    slug: "how-to-spot-a-phishing-email",
    body: `Be suspicious of messages that:

- create urgency ("your account will be closed today"),
- ask you to sign in through a link or open an unexpected attachment,
- come from a slightly misspelled address.

If in doubt, don't click. Forward the message to support or open a ticket in the **Security** category.

> ${SAMPLE_NOTE}`,
  },
  {
    collection: "staff-runbooks",
    title: "New client onboarding checklist",
    slug: "new-client-onboarding-checklist",
    body: `1. Create the company and contacts, and mark the main contact as company admin.
2. Record devices, licenses and domains under Assets.
3. Add the contract with covered hours and SLA policy.
4. Fill in the client documentation sections (network, vendors, licenses). Store credentials in your password vault and link to them; never paste passwords here.
5. Invite the client contacts to the portal.

> ${SAMPLE_NOTE}`,
  },
];

const CANNED_RESPONSES: { title: string; body: string }[] = [
  {
    title: "Acknowledge and investigating",
    body: "Hi {{requester.firstName}},\n\nThanks for reaching out. We're looking into {{ticket.number}} now and will update you shortly.\n\n{{agent.name}}",
  },
  {
    title: "Need more information",
    body: "Hi {{requester.firstName}},\n\nTo help us with this, could you send:\n\n- a screenshot of the error\n- when it started\n- whether anyone else is affected\n\nThanks,\n{{agent.firstName}}",
  },
  {
    title: "Resolved, please confirm",
    body: "Hi {{requester.firstName}},\n\nWe believe this is fixed. If anything still isn't working, reply to this message and the ticket will reopen.\n\n{{agent.name}}",
  },
  {
    title: "Scheduling a remote session",
    body: "Hi {{requester.firstName}},\n\nWe'd like to connect remotely to take a look. Please reply with a time that suits you today or tomorrow.\n\n{{agent.firstName}}",
  },
];

const ANNOUNCEMENT_TEMPLATES: { name: string; type: string; severity: string; title: string; body: string }[] = [
  {
    name: "Planned maintenance",
    type: "maintenance",
    severity: "minor",
    title: "Planned maintenance",
    body: "We will perform planned maintenance during the window shown. Services may be briefly unavailable. No action is needed on your part.",
  },
  {
    name: "Service outage",
    type: "incident",
    severity: "major",
    title: "Service disruption",
    body: "We are aware of an issue affecting some services and are investigating. We will post updates here as we learn more.",
  },
  {
    name: "Phishing alert",
    type: "security",
    severity: "major",
    title: "Phishing campaign targeting our clients",
    body: "We have seen phishing emails asking recipients to sign in through a link. Do not click links in unexpected messages. If you entered your password, open a Security ticket right away.",
  },
  {
    name: "Office closure",
    type: "general",
    severity: "info",
    title: "Office closure",
    body: "Our office will be closed on the date shown. Emergency support remains available through the portal.",
  },
];

export interface SampleContentResult {
  created: Record<string, number>;
}

export async function seedSampleContent(prisma: PrismaClient, organizationId: string): Promise<SampleContentResult> {
  const created: Record<string, number> = {};
  const bump = (key: string): void => {
    created[key] = (created[key] ?? 0) + 1;
  };

  // Business hours and SLA policy
  let hours = await prisma.businessHours.findFirst({ where: { organizationId } });
  if (!hours) {
    const settings = await prisma.systemSettings.findUnique({ where: { organizationId }, select: { timezone: true } });
    hours = await prisma.businessHours.create({
      data: { organizationId, name: "Business hours", timezone: settings?.timezone ?? "UTC", schedule: DEFAULT_BUSINESS_SCHEDULE },
    });
    bump("businessHours");
  }
  let policy = await prisma.slaPolicy.findFirst({ where: { organizationId } });
  if (!policy) {
    policy = await prisma.slaPolicy.create({
      data: { organizationId, name: "Standard", targets: DEFAULT_SLA_TARGETS, businessHoursId: hours.id },
    });
    bump("slaPolicies");
  }
  await prisma.serviceSettings.upsert({
    where: { organizationId },
    create: { organizationId, defaultSlaPolicyId: policy.id },
    update: {},
  });
  await prisma.serviceSettings.updateMany({
    where: { organizationId, defaultSlaPolicyId: null },
    data: { defaultSlaPolicyId: policy.id },
  });

  // Ticket categories
  for (const [order, c] of DEFAULT_TICKET_CATEGORIES.entries()) {
    const exists = await prisma.ticketCategory.findFirst({ where: { organizationId, name: c.name } });
    if (exists) continue;
    await prisma.ticketCategory.create({ data: { organizationId, order, ...c } });
    bump("ticketCategories");
  }

  // Service catalog
  const itemIds = new Map<string, string>();
  for (const item of CATALOG_ITEMS) {
    let row = await prisma.catalogItem.findFirst({ where: { organizationId, name: item.name }, select: { id: true } });
    if (!row) {
      row = await prisma.catalogItem.create({ data: { organizationId, ...item }, select: { id: true } });
      bump("catalogItems");
    }
    itemIds.set(item.name, row.id);
  }
  for (const bundle of BUNDLES) {
    const exists = await prisma.catalogBundle.findFirst({ where: { organizationId, name: bundle.name } });
    if (exists) continue;
    await prisma.catalogBundle.create({
      data: {
        organizationId,
        name: bundle.name,
        description: bundle.description,
        items: {
          create: bundle.items
            .filter((i) => itemIds.has(i.name))
            .map((i, order) => ({
              catalogItemId: itemIds.get(i.name) as string,
              quantity: i.quantity,
              optional: i.optional ?? false,
              order,
            })),
        },
      },
    });
    bump("catalogBundles");
  }

  // Knowledge base (drafts, so nothing reaches clients until someone reviews and publishes it)
  const collectionIds = new Map<string, string>();
  for (const [order, c] of KB_COLLECTIONS.entries()) {
    let row = await prisma.kbCollection.findFirst({ where: { organizationId, slug: c.slug }, select: { id: true } });
    if (!row) {
      row = await prisma.kbCollection.create({ data: { organizationId, order, ...c }, select: { id: true } });
      bump("kbCollections");
    }
    collectionIds.set(c.slug, row.id);
  }
  for (const a of KB_ARTICLES) {
    const exists = await prisma.kbArticle.findFirst({ where: { organizationId, slug: a.slug } });
    if (exists) continue;
    await prisma.kbArticle.create({
      data: {
        organizationId,
        collectionId: collectionIds.get(a.collection) ?? null,
        title: a.title,
        slug: a.slug,
        body: a.body,
        excerpt: a.body.split("\n")[0].replace(/[*_`>#]/g, "").slice(0, 200),
        status: "draft",
        visibility: a.collection === "staff-runbooks" ? "internal" : "clients",
        reviewBy: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
      },
    });
    bump("kbArticles");
  }

  // Canned responses (shared)
  for (const r of CANNED_RESPONSES) {
    const exists = await prisma.cannedResponse.findFirst({ where: { organizationId, title: r.title, ownerId: null } });
    if (exists) continue;
    await prisma.cannedResponse.create({ data: { organizationId, ...r } });
    bump("cannedResponses");
  }

  // Announcement templates
  for (const t of ANNOUNCEMENT_TEMPLATES) {
    const exists = await prisma.announcementTemplate.findFirst({ where: { organizationId, name: t.name } });
    if (exists) continue;
    await prisma.announcementTemplate.create({ data: { organizationId, ...t } });
    bump("announcementTemplates");
  }

  return { created };
}
