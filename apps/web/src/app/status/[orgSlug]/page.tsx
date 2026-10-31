import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckCircle2, AlertTriangle, Rss, Wrench } from "lucide-react";
import { internalApiUrl } from "@/lib/server-api";
import { getBrandingBySlug, buildBrandingStyle, type BrandingData } from "@/lib/branding";
import { Markdown } from "@/components/markdown";
import { AnnouncementTimeline } from "@/components/announcement-timeline";
import {
  ANNOUNCEMENT_TYPE_LABELS,
  INCIDENT_STATE_LABELS,
  SEVERITY_LABELS,
  formatWindow,
  severityStyle,
  type AnnouncementUpdateItem,
} from "@/lib/announcements";

interface StatusItem {
  id: string;
  type: string;
  severity: string;
  incidentState: string | null;
  title: string;
  body: string;
  impact: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  publishedAt: string | null;
  resolvedAt: string | null;
  postmortem: string | null;
  updates: AnnouncementUpdateItem[];
}

interface StatusResponse {
  org: { name: string; slug: string };
  activeIncidents: StatusItem[];
  maintenance: StatusItem[];
  history: StatusItem[];
}

type Params = Promise<{ orgSlug: string }>;

async function loadStatus(slug: string): Promise<StatusResponse | null> {
  const res = await fetch(`${internalApiUrl()}/api/status/${encodeURIComponent(slug)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Status page fetch failed: ${res.status}`);
  return res.json();
}

async function loadBranding(slug: string): Promise<BrandingData | null> {
  try {
    return await getBrandingBySlug(slug);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { orgSlug } = await params;
  const status = await loadStatus(orgSlug).catch(() => null);
  if (!status) return { title: "Status" };
  return {
    title: `${status.org.name} status`,
    alternates: {
      types: {
        "application/rss+xml": `${process.env.NEXT_PUBLIC_API_URL || ""}/api/status/${encodeURIComponent(orgSlug)}/rss`,
      },
    },
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function Item({ item }: { item: StatusItem }): React.ReactElement {
  const windowText = item.type === "maintenance" ? formatWindow(item.windowStart, item.windowEnd) : null;
  return (
    <article id={item.id} className="border border-[var(--border)] rounded-lg p-4" data-testid="status-item">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--muted)]">{ANNOUNCEMENT_TYPE_LABELS[item.type] ?? item.type}</span>
        {item.severity !== "info" && (
          <span className={`text-xs px-2 py-0.5 rounded-full ${severityStyle(item.severity).badge}`}>
            {SEVERITY_LABELS[item.severity] ?? item.severity}
          </span>
        )}
        {item.type === "incident" && item.incidentState && (
          <span className="text-xs font-medium">{INCIDENT_STATE_LABELS[item.incidentState] ?? item.incidentState}</span>
        )}
        <span className="ml-auto text-xs text-[var(--muted-foreground)]">{formatDate(item.resolvedAt ?? item.publishedAt)}</span>
      </div>
      <h3 className="font-semibold">{item.title}</h3>
      {windowText && <p className="text-sm text-[var(--muted-foreground)]">{windowText}</p>}
      {item.impact && <p className="text-sm mt-1">Impact: {item.impact}</p>}
      <div className="mt-2">
        <Markdown source={item.body} />
      </div>
      <AnnouncementTimeline updates={item.updates} />
      {item.postmortem && (
        <div className="mt-4 rounded-lg bg-[var(--muted)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide mb-1">Postmortem</p>
          <Markdown source={item.postmortem} />
        </div>
      )}
    </article>
  );
}

export default async function PublicStatusPage({ params }: { params: Params }): Promise<React.ReactElement> {
  const { orgSlug } = await params;
  const [status, branding] = await Promise.all([loadStatus(orgSlug), loadBranding(orgSlug)]);
  if (!status) notFound();

  const operational = status.activeIncidents.length === 0;
  const rssHref = `${process.env.NEXT_PUBLIC_API_URL || ""}/api/status/${encodeURIComponent(orgSlug)}/rss`;

  return (
    <div className="min-h-screen bg-[var(--background)]" style={buildBrandingStyle(branding)}>
      <header className="border-b border-[var(--border)] px-4 sm:px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          {branding?.logoSrc && !branding.hideLogo && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={branding.logoSrc} alt="" className="h-8 w-8 object-contain" />
          )}
          <h1 className="font-semibold flex-1">{status.org.name} status</h1>
          <a href={rssHref} className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            <Rss size={14} />
            RSS
          </a>
        </div>
      </header>
      <main className="max-w-3xl mx-auto p-4 sm:p-6 space-y-8">
        <div
          className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
            operational ? "border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-100" : severityStyle("major").box
          }`}
          data-testid="status-summary"
        >
          {operational ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
          <p className="font-medium">{operational ? "All systems operational" : "Some services are affected"}</p>
        </div>

        {status.activeIncidents.length > 0 && (
          <section aria-label="Active incidents" className="space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <AlertTriangle size={18} />
              Active incidents
            </h2>
            {status.activeIncidents.map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </section>
        )}

        {status.maintenance.length > 0 && (
          <section aria-label="Scheduled maintenance" className="space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Wrench size={18} />
              Scheduled maintenance
            </h2>
            {status.maintenance.map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </section>
        )}

        <section aria-label="History" className="space-y-3">
          <h2 className="text-lg font-semibold">Past 30 days</h2>
          {status.history.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">No incidents reported.</p>
          ) : (
            status.history.map((item) => <Item key={item.id} item={item} />)
          )}
        </section>
      </main>
    </div>
  );
}
