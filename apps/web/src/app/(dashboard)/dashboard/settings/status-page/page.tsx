"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useSession } from "@/lib/session-context";

interface StatusSettings {
  statusPageEnabled: boolean;
  slug: string | null;
}

export default function StatusPageSettings(): React.ReactElement {
  const toast = useToast();
  const { role } = useSession();
  const [settings, setSettings] = useState<StatusSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const isOwner = role === "owner";

  useEffect(() => {
    apiFetch<StatusSettings>("/announcements/settings")
      .then(setSettings)
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load settings"));
  }, [toast]);

  const toggle = async (enabled: boolean): Promise<void> => {
    setSaving(true);
    try {
      const updated = await apiFetch<StatusSettings>("/announcements/settings", {
        method: "PUT",
        body: JSON.stringify({ statusPageEnabled: enabled }),
      });
      setSettings(updated);
      toast.success(enabled ? "Status page enabled" : "Status page disabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update");
    } finally {
      setSaving(false);
    }
  };

  const path = settings?.slug ? `/status/${settings.slug}` : null;

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Public status page</h2>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          A public page (and RSS feed) listing active incidents, upcoming maintenance and the last 30 days of history.
          Only announcements sent to all clients and marked &quot;Show on the public status page&quot; appear on it.
        </p>
      </div>
      {settings && (
        <>
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              role="switch"
              aria-label="Enable public status page"
              checked={settings.statusPageEnabled}
              disabled={!isOwner || saving}
              onChange={(e) => toggle(e.target.checked)}
            />
            Enable public status page
          </label>
          {!isOwner && <p className="text-xs text-[var(--muted-foreground)]">Only the workspace owner can change this.</p>}
          {settings.statusPageEnabled && path && (
            <p className="text-sm">
              <Link href={path} target="_blank" className="inline-flex items-center gap-1 underline">
                {path}
                <ExternalLink size={12} />
              </Link>
            </p>
          )}
          {!settings.slug && (
            <p className="text-sm text-[var(--muted-foreground)]">This workspace has no URL slug yet, so the page has no address.</p>
          )}
        </>
      )}
    </div>
  );
}
