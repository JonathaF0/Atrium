"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { useSession } from "@/lib/session-context";

const LABELS: Record<string, string> = {
  businessHours: "business hours",
  slaPolicies: "SLA policy",
  ticketCategories: "ticket categories",
  catalogItems: "catalog items",
  catalogBundles: "catalog bundles",
  kbCollections: "knowledge base collections",
  kbArticles: "draft articles",
  cannedResponses: "canned responses",
  announcementTemplates: "announcement templates",
};

export function SampleContentSection(): React.ReactElement | null {
  const { role } = useSession();
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState<boolean>(false);

  if (role !== "owner") return null;

  async function load(): Promise<void> {
    const ok = await confirm({
      title: "Load sample content",
      message:
        "Adds editable sample ticket categories, an SLA policy, a service catalog, draft help articles, canned responses and announcement templates. Nothing you already have is changed, and articles stay drafts until you publish them.",
      confirmLabel: "Load sample content",
    });
    if (!ok) return;
    setLoading(true);
    try {
      const { created } = await apiFetch<{ created: Record<string, number> }>("/service-settings/sample-content", {
        method: "POST",
      });
      const parts: string[] = Object.entries(created).map(([k, n]) => `${n} ${LABELS[k] ?? k}`);
      success(parts.length ? `Added ${parts.join(", ")}` : "Sample content is already loaded");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to load sample content");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h2 className="text-base font-semibold">Sample content</h2>
      <p className="text-sm text-[var(--muted-foreground)] mt-0.5">
        Starter content for an IT services workspace that you can edit or delete.
      </p>
      <button
        onClick={load}
        disabled={loading}
        className="mt-4 px-4 py-2 text-sm border border-[var(--border)] rounded-lg hover:bg-[var(--muted)] disabled:opacity-50"
      >
        {loading ? "Loading..." : "Load sample content"}
      </button>
    </div>
  );
}
