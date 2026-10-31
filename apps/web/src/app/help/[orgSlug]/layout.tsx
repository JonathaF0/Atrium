import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { buildBrandingStyle, getBrandingBySlug } from "@/lib/branding";
import { internalApiUrl } from "@/lib/server-api";
import { ThemeToggle } from "@/components/theme-toggle";

/** The workspace's public help center, or null when it is off (the API answers 404). */
async function getHelpCenter(orgSlug: string): Promise<{ name: string; slug: string } | null> {
  const res: Response = await fetch(`${internalApiUrl()}/api/kb/public/${encodeURIComponent(orgSlug)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Help center lookup failed: ${res.status}`);
  return res.json();
}

export async function generateMetadata({ params }: { params: Promise<{ orgSlug: string }> }): Promise<Metadata> {
  const { orgSlug } = await params;
  const center = await getHelpCenter(orgSlug).catch(() => null);
  return center ? { title: `${center.name} help center` } : {};
}

export default async function HelpCenterLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const center = await getHelpCenter(orgSlug);
  if (!center) notFound();
  const branding = await getBrandingBySlug(orgSlug).catch(() => null);
  const name: string = branding?.orgName || center.name;

  return (
    <div style={buildBrandingStyle(branding)} className="min-h-screen">
      <header className="border-b border-[var(--border)] px-4 sm:px-6 py-4 flex items-center gap-3">
        {branding?.logoSrc && !branding.hideLogo && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={branding.logoSrc} alt="Logo" className="h-8 w-8 object-contain shrink-0" />
        )}
        <Link href={`/help/${orgSlug}`} className="font-semibold flex-1 min-w-0 truncate">
          {name}
        </Link>
        <Link href="/login" className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
          Sign in
        </Link>
        <ThemeToggle />
      </header>
      <main className="max-w-6xl mx-auto p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
