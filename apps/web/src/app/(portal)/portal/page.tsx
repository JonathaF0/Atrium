"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  CalendarClock,
  CreditCard,
  FileText,
  LifeBuoy,
  Megaphone,
  MessageSquarePlus,
  Newspaper,
  Plus,
} from "lucide-react";
import { formatMoney } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { formatRelativeTime } from "@/lib/utils";
import { Skeleton } from "@/components/skeletons";
import { AnnouncementBanner } from "@/components/announcement-banner";
import type { PortalAnnouncement } from "@/lib/announcements";

interface PortalHome {
  company: { name: string; companyAdmin: boolean } | null;
  tickets: {
    openCount: number;
    latest: { id: string; reference: string; subject: string; status: string; priority: string; lastActivityAt: string }[];
  } | null;
  invoices: {
    currency: string;
    outstandingCount: number;
    overdueCount: number;
    outstandingCents: number;
    latest: {
      id: string;
      invoiceNumber: string;
      status: string;
      dueDate: string | null;
      amountCents: number;
      projectId: string | null;
      projectName: string | null;
    }[];
  } | null;
  renewals: {
    assets: { id: string; name: string; type: string; vendor: string | null; kind: "warranty" | "renewal"; date: string }[];
    contracts: { id: string; name: string; type: string; endsAt: string; autoRenew: boolean }[] | null;
  } | null;
  updates: {
    latest: { id: string; projectId: string; projectName: string; excerpt: string; createdAt: string }[];
  } | null;
  announcements: { unread: number; banner: PortalAnnouncement[] } | null;
  quickActions: { requestProjectId: string | null; payInvoiceProjectId: string | null };
}

const TICKET_STATUS_LABELS: Record<string, string> = {
  new: "New",
  open: "Open",
  waiting_client: "Waiting on you",
  waiting_third_party: "Waiting on third party",
  on_hold: "On hold",
};

function formatDate(iso: string | null): string {
  if (!iso) return "No due date";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Card({
  title,
  icon: Icon,
  action,
  children,
  testId,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}): React.ReactElement {
  return (
    <section className="border border-[var(--border)] rounded-lg p-4 flex flex-col" data-testid={testId} aria-label={title}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="font-semibold flex items-center gap-2">
          <Icon size={16} className="text-[var(--muted-foreground)]" />
          {title}
        </h2>
        {action}
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

function Unavailable(): React.ReactElement {
  return <p className="text-sm text-[var(--muted-foreground)]">Not available right now.</p>;
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="text-sm text-[var(--muted-foreground)]">{children}</p>;
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: React.ComponentType<{ size?: number }>; label: string }): React.ReactElement {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 px-4 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)] transition-colors"
    >
      <Icon size={16} />
      {label}
    </Link>
  );
}

export default function PortalHomePage(): React.ReactElement {
  const [home, setHome] = useState<PortalHome | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<PortalHome>("/portal-home/mine")
      .then(setHome)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  if (error) {
    return <div className="p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>;
  }

  if (!home) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-8 w-56" />
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const payHref = home.quickActions.payInvoiceProjectId
    ? `/portal/projects/${home.quickActions.payInvoiceProjectId}?tab=invoices`
    : "/portal/projects";
  const requestHref = home.quickActions.requestProjectId
    ? `/portal/projects/${home.quickActions.requestProjectId}?tab=tasks`
    : "/portal/projects";

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Welcome back</h1>
        {home.company && <p className="text-sm text-[var(--muted-foreground)] mt-1">{home.company.name}</p>}
      </div>

      <AnnouncementBanner initialItems={home.announcements?.banner ?? []} />

      <div className="flex flex-wrap gap-2 mb-6" aria-label="Quick actions">
        <QuickAction href="/portal/tickets/new" icon={Plus} label="New ticket" />
        {(home.invoices?.outstandingCount ?? 0) > 0 && <QuickAction href={payHref} icon={CreditCard} label="Pay invoice" />}
        <QuickAction href="/portal/kb" icon={BookOpen} label="Help center" />
        <QuickAction href={requestHref} icon={MessageSquarePlus} label="Request work" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card
          title="Open tickets"
          icon={LifeBuoy}
          testId="home-tickets"
          action={
            <Link href="/portal/tickets" className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
              View all
            </Link>
          }
        >
          {!home.tickets ? (
            <Unavailable />
          ) : (
            <>
              <p className="text-3xl font-semibold mb-2" data-testid="home-open-ticket-count">
                {home.tickets.openCount}
              </p>
              {home.tickets.latest.length === 0 ? (
                <Empty>No open tickets.</Empty>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {home.tickets.latest.map((t) => (
                    <li key={t.id}>
                      <Link href={`/portal/tickets/${t.id}`} className="flex items-center justify-between gap-3 py-2 text-sm hover:underline">
                        <span className="min-w-0 truncate">
                          <span className="text-[var(--muted-foreground)] mr-2">{t.reference}</span>
                          {t.subject}
                        </span>
                        <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-[var(--muted)]">
                          {TICKET_STATUS_LABELS[t.status] ?? t.status}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>

        <Card title="Outstanding invoices" icon={FileText} testId="home-invoices">
          {!home.invoices ? (
            <Unavailable />
          ) : home.invoices.outstandingCount === 0 ? (
            <Empty>You&apos;re all paid up.</Empty>
          ) : (
            <>
              <p className="text-3xl font-semibold" data-testid="home-outstanding-total">
                {formatMoney(home.invoices.outstandingCents, home.invoices.currency)}
              </p>
              <p className="text-xs text-[var(--muted-foreground)] mb-2">
                {home.invoices.outstandingCount} open
                {home.invoices.overdueCount > 0 && (
                  <span className="text-red-600 font-medium"> · {home.invoices.overdueCount} overdue</span>
                )}
              </p>
              <ul className="divide-y divide-[var(--border)]">
                {home.invoices.latest.map((inv) => (
                  <li key={inv.id}>
                    <Link
                      href={inv.projectId ? `/portal/projects/${inv.projectId}?tab=invoices` : "/portal/projects"}
                      className="flex items-center justify-between gap-3 py-2 text-sm hover:underline"
                    >
                      <span className="min-w-0 truncate">
                        {inv.invoiceNumber}
                        {inv.projectName && <span className="text-[var(--muted-foreground)]"> · {inv.projectName}</span>}
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block">{formatMoney(inv.amountCents, home.invoices?.currency)}</span>
                        <span className={`block text-xs ${inv.status === "overdue" ? "text-red-600" : "text-[var(--muted-foreground)]"}`}>
                          {inv.status === "overdue" ? "Overdue" : `Due ${formatDate(inv.dueDate)}`}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="Upcoming renewals" icon={CalendarClock} testId="home-renewals">
          {!home.renewals ? (
            <Unavailable />
          ) : home.renewals.assets.length === 0 && (home.renewals.contracts?.length ?? 0) === 0 ? (
            <Empty>Nothing renews in the next 60 days.</Empty>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {home.renewals.assets.map((a) => (
                <li key={`${a.id}-${a.kind}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate">
                    {a.name}
                    {a.vendor && <span className="text-[var(--muted-foreground)]"> · {a.vendor}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
                    {a.kind === "warranty" ? "Warranty ends" : "Renews"} {formatDate(a.date)}
                  </span>
                </li>
              ))}
              {(home.renewals.contracts ?? []).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{c.name}</span>
                  <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
                    {c.autoRenew ? "Auto-renews" : "Ends"} {formatDate(c.endsAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Recent project updates"
          icon={Newspaper}
          testId="home-updates"
          action={
            <Link href="/portal/projects" className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
              All projects
            </Link>
          }
        >
          {!home.updates ? (
            <Unavailable />
          ) : home.updates.latest.length === 0 ? (
            <Empty>No updates yet.</Empty>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {home.updates.latest.map((u) => (
                <li key={u.id}>
                  <Link href={`/portal/projects/${u.projectId}`} className="block py-2 text-sm hover:bg-[var(--muted)] -mx-2 px-2 rounded">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="font-medium truncate">{u.projectName}</span>
                      <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{formatRelativeTime(u.createdAt)}</span>
                    </span>
                    <span className="block text-[var(--muted-foreground)] line-clamp-2">{u.excerpt}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Announcements"
          icon={Megaphone}
          testId="home-announcements"
          action={
            <Link href="/portal/announcements" className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
              View all
            </Link>
          }
        >
          {!home.announcements ? (
            <Unavailable />
          ) : home.announcements.unread > 0 ? (
            <p className="text-sm">
              <span className="font-semibold">{home.announcements.unread}</span> unread{" "}
              {home.announcements.unread === 1 ? "announcement" : "announcements"}.
            </p>
          ) : (
            <Empty>You&apos;re up to date.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
