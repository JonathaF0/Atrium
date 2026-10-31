"use client";

import { useEffect, useState } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useDebounce } from "@/hooks/use-debounce";
import type { KbArticleSummary } from "@/lib/kb";

const MIN_SUBJECT_LENGTH = 4;

/**
 * Suggests help center articles while a client writes a ticket subject.
 * Opening one records a "viewed" deflection so staff can see which articles
 * head off tickets.
 */
export function KbSuggestions({ subject, categoryId }: { subject: string; categoryId?: string }) {
  const q: string = useDebounce(subject.trim(), 400);
  const [articles, setArticles] = useState<KbArticleSummary[]>([]);

  useEffect(() => {
    if (q.length < MIN_SUBJECT_LENGTH) {
      setArticles([]);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ q: q.slice(0, 200) });
    if (categoryId) params.set("categoryId", categoryId);
    apiFetch<KbArticleSummary[]>(`/kb/mine/suggest?${params}`)
      .then((rows) => !cancelled && setArticles(rows))
      .catch(() => !cancelled && setArticles([]));
    return () => {
      cancelled = true;
    };
  }, [q, categoryId]);

  function recordView(articleId: string): void {
    apiFetch("/kb/mine/deflections", {
      method: "POST",
      body: JSON.stringify({ articleId, outcome: "viewed" }),
    }).catch(() => undefined);
  }

  if (articles.length === 0) return null;

  return (
    <div className="border border-[var(--border)] rounded-xl p-3 space-y-2" aria-label="Suggested articles" data-testid="kb-suggestions">
      <p className="text-xs font-semibold text-[var(--muted-foreground)] flex items-center gap-1.5">
        <BookOpen size={13} /> These articles might help
      </p>
      <ul className="space-y-1">
        {articles.map((a) => (
          <li key={a.id}>
            <a
              href={`/portal/kb/${a.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => recordView(a.id)}
              onAuxClick={() => recordView(a.id)}
              className="text-sm text-[var(--primary)] hover:underline inline-flex items-center gap-1"
            >
              {a.title} <ExternalLink size={12} />
            </a>
            {a.excerpt && <p className="text-xs text-[var(--muted-foreground)] line-clamp-1">{a.excerpt}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
