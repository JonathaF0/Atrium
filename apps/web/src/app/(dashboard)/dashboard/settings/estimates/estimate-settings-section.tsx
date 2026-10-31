"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";

interface EstimateSettings {
  estimatePrefix: string;
  nextEstimateNumber: number;
  estimateValidDays: number;
  estimateDefaultTerms: string | null;
  aiAssistEnabled: boolean;
  aiServerConfigured: boolean;
}

const inputClass =
  "w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm outline-none focus:ring-1 focus:ring-[var(--primary)]";

export function EstimateSettingsSection(): React.ReactElement {
  const { success, error: showError } = useToast();
  const [settings, setSettings] = useState<EstimateSettings | null>(null);
  const [prefix, setPrefix] = useState("");
  const [validDays, setValidDays] = useState("30");
  const [terms, setTerms] = useState("");
  const [ai, setAi] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<EstimateSettings>("/estimates/settings")
      .then((s) => {
        setSettings(s);
        setPrefix(s.estimatePrefix);
        setValidDays(String(s.estimateValidDays));
        setTerms(s.estimateDefaultTerms ?? "");
        setAi(s.aiAssistEnabled);
      })
      .catch((err) => showError(err instanceof Error ? err.message : "Failed to load estimate settings"));
  }, [showError]);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    try {
      const s = await apiFetch<EstimateSettings>("/estimates/settings", {
        method: "PUT",
        body: JSON.stringify({
          estimatePrefix: prefix.trim(),
          estimateValidDays: Math.max(1, Math.min(365, parseInt(validDays, 10) || 30)),
          estimateDefaultTerms: terms.trim() || null,
          aiAssistEnabled: ai,
        }),
      });
      setSettings(s);
      setPrefix(s.estimatePrefix);
      success("Estimate settings saved");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>;

  return (
    <form onSubmit={save} className="space-y-4 max-w-xl">
      <div>
        <h2 className="text-base font-semibold">Estimates</h2>
        <p className="text-sm text-[var(--muted-foreground)] mt-0.5">
          Numbering, validity and default terms for new estimates. The next number is {settings.estimatePrefix}-{settings.nextEstimateNumber}.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-[var(--muted-foreground)]">Number prefix</span>
          <input aria-label="Number prefix" maxLength={10} value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} className={inputClass} />
        </label>
        <label className="text-sm">
          <span className="text-[var(--muted-foreground)]">Valid for (days)</span>
          <input aria-label="Valid for days" inputMode="numeric" value={validDays} onChange={(e) => setValidDays(e.target.value.replace(/\D/g, ""))} className={inputClass} />
        </label>
      </div>
      <label className="block text-sm">
        <span className="text-[var(--muted-foreground)]">Default terms (markdown)</span>
        <textarea aria-label="Default terms" rows={5} maxLength={20000} value={terms} onChange={(e) => setTerms(e.target.value)} className={inputClass} />
      </label>
      <label className={`flex items-start gap-2 text-sm ${settings.aiServerConfigured ? "" : "opacity-60"}`}>
        <input type="checkbox" className="mt-1" checked={ai} disabled={!settings.aiServerConfigured} onChange={(e) => setAi(e.target.checked)} />
        <span>
          AI drafting assistant
          <span className="block text-xs text-[var(--muted-foreground)]">
            {settings.aiServerConfigured
              ? "Suggests a scope and line items from a description or ticket. Suggestions are never saved or sent without your review. Request text is sent to the configured AI provider."
              : "Not available: the server administrator has not configured an AI provider."}
          </span>
        </span>
      </label>
      <button type="submit" disabled={saving} className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-50">
        {saving ? "Saving..." : "Save"}
      </button>
    </form>
  );
}
