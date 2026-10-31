"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BarChart3, Plus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { ArticlesPanel } from "./articles-panel";
import { CollectionsPanel } from "./collections-panel";
import { KbSettingsCard } from "./kb-settings-card";
import { buttonClass, primaryButtonClass } from "./styles";

type Tab = "articles" | "collections";

export default function KnowledgeBasePage() {
  const router = useRouter();
  const params = useSearchParams();
  const { error: showError } = useToast();
  const [tab, setTab] = useState<Tab>(params.get("tab") === "collections" ? "collections" : "articles");
  const [creating, setCreating] = useState(false);

  async function newArticle(): Promise<void> {
    setCreating(true);
    try {
      const created = await apiFetch<{ id: string }>("/kb/articles", {
        method: "POST",
        body: JSON.stringify({ title: "Untitled article", body: "" }),
      });
      router.push(`/dashboard/kb/articles/${created.id}`);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to create article");
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Knowledge base</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            Help articles for your clients and your team. Any owner or admin can publish.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/kb/stats" className={`${buttonClass} inline-flex items-center gap-1.5`}>
            <BarChart3 size={16} /> Stats
          </Link>
          <button onClick={newArticle} disabled={creating} className={`${primaryButtonClass} inline-flex items-center gap-1.5`}>
            <Plus size={16} /> New article
          </button>
        </div>
      </div>

      <KbSettingsCard />

      <div className="flex gap-1 border-b border-[var(--border)]" role="tablist">
        {(["articles", "collections"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${
              tab === t ? "border-[var(--primary)] font-medium" : "border-transparent text-[var(--muted-foreground)]"
            }`}
          >
            {t === "articles" ? "Articles" : "Collections"}
          </button>
        ))}
      </div>

      {tab === "articles" ? <ArticlesPanel initialReview={params.get("review") === "stale" ? "stale" : ""} /> : <CollectionsPanel />}
    </div>
  );
}
