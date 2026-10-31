"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { selectClass } from "./styles";

interface KbSettings {
  kbPublicEnabled: boolean;
  kbReviewDays: number;
  orgSlug: string | null;
}

const REVIEW_OPTIONS: number[] = [30, 90, 180, 365];

/** Public help center switch and the default review interval. */
export function KbSettingsCard() {
  const { success, error: showError } = useToast();
  const [settings, setSettings] = useState<KbSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<KbSettings>("/kb/settings").then(setSettings).catch(() => setSettings(null));
  }, []);

  async function save(changes: Partial<KbSettings>): Promise<void> {
    setSaving(true);
    try {
      const next = await apiFetch<KbSettings>("/kb/settings", { method: "PATCH", body: JSON.stringify(changes) });
      setSettings(next);
      success("Knowledge base settings saved");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;
  const reviewOptions: number[] = REVIEW_OPTIONS.includes(settings.kbReviewDays)
    ? REVIEW_OPTIONS
    : [...REVIEW_OPTIONS, settings.kbReviewDays].sort((a, b) => a - b);

  return (
    <div className="border border-[var(--border)] rounded-xl p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.kbPublicEnabled}
          disabled={saving}
          onChange={(e) => save({ kbPublicEnabled: e.target.checked })}
        />
        Public help center
      </label>
      {settings.kbPublicEnabled && settings.orgSlug && (
        <a
          href={`/help/${settings.orgSlug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[var(--primary)] hover:underline inline-flex items-center gap-1"
        >
          /help/{settings.orgSlug} <ExternalLink size={13} />
        </a>
      )}
      <span className="text-xs text-[var(--muted-foreground)] flex-1 min-w-[12rem]">
        {settings.kbPublicEnabled
          ? "Anyone with the link can read articles marked Public (in Public collections)."
          : "Off: only signed-in clients can read the knowledge base."}
      </span>
      <label className="flex items-center gap-2 text-sm">
        Review articles every
        <select
          value={settings.kbReviewDays}
          disabled={saving}
          onChange={(e) => save({ kbReviewDays: Number(e.target.value) })}
          className={selectClass}
          aria-label="Default review interval"
        >
          {reviewOptions.map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
