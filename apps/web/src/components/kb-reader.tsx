"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FileText, Folder, Paperclip, Search, ThumbsDown, ThumbsUp } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/api";
import { useDebounce } from "@/hooks/use-debounce";
import { Markdown } from "@/components/markdown";
import { flattenTree, formatDate, kbAttachmentUrl, kbBodyForDisplay } from "@/lib/kb";
import type { KbArticleSummary, KbReaderArticle, KbReaderCollection } from "@/lib/kb";

/**
 * Where a reader view gets its data and links: the portal (`/kb/mine`, signed
 * in) or the public help center (`/kb/public/<org>`, anonymous).
 */
export interface KbReaderSource {
  apiBase: string;
  linkBase: string;
  publicOrgSlug?: string;
}

const inputClass =
  "w-full pl-9 pr-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm outline-none focus:ring-1 focus:ring-[var(--primary)]";

function ArticleList({ articles, linkBase }: { articles: KbArticleSummary[]; linkBase: string }) {
  return (
    <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl">
      {articles.map((a) => (
        <li key={a.id}>
          <Link href={`${linkBase}/${a.slug}`} className="flex gap-3 px-4 py-3 hover:bg-[var(--muted)]">
            <FileText size={16} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{a.title}</span>
              {a.excerpt && <span className="block text-xs text-[var(--muted-foreground)] line-clamp-2">{a.excerpt}</span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Collections, articles and search. */
export function KbHome({ source, title = "Help center" }: { source: KbReaderSource; title?: string }) {
  const [collections, setCollections] = useState<KbReaderCollection[] | null>(null);
  const [uncategorized, setUncategorized] = useState(0);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [articles, setArticles] = useState<KbArticleSummary[] | null>(null);
  const [q, setQ] = useState("");
  const query: string = useDebounce(q.trim(), 300);
  const [results, setResults] = useState<KbArticleSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiFetch<{ collections: KbReaderCollection[]; uncategorizedCount: number }>(`${source.apiBase}/collections`)
      .then((res) => {
        setCollections(res.collections);
        setUncategorized(res.uncategorizedCount);
      })
      .catch(() => setFailed(true));
  }, [source.apiBase]);

  useEffect(() => {
    const params = new URLSearchParams({ limit: "50" });
    if (collectionId) params.set("collectionId", collectionId);
    apiFetch<PaginatedResponse<KbArticleSummary>>(`${source.apiBase}/articles?${params}`)
      .then((res) => setArticles(res.data))
      .catch(() => setArticles([]));
  }, [source.apiBase, collectionId]);

  useEffect(() => {
    if (query.length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    apiFetch<KbArticleSummary[]>(`${source.apiBase}/search?q=${encodeURIComponent(query)}`)
      .then((rows) => !cancelled && setResults(rows))
      .catch(() => !cancelled && setResults([]));
    return () => {
      cancelled = true;
    };
  }, [source.apiBase, query]);

  const tree = useMemo(() => flattenTree(collections ?? []), [collections]);
  const current: KbReaderCollection | undefined = tree.find((c) => c.id === collectionId);
  const visibleArticles: KbArticleSummary[] = (articles ?? []).filter((a) => (collectionId ? a.collectionId === collectionId : true));

  if (failed) return <p className="text-sm text-[var(--muted-foreground)]">The help center is unavailable right now.</p>;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">{title}</h1>
        <div className="relative max-w-xl">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search articles"
            aria-label="Search articles"
            maxLength={200}
            className={inputClass}
          />
        </div>
      </div>

      {results ? (
        <section className="space-y-2" aria-label="Search results">
          <h2 className="text-sm font-semibold">
            {results.length === 0 ? `No articles match "${query}"` : `Results for "${query}"`}
          </h2>
          {results.length > 0 && <ArticleList articles={results} linkBase={source.linkBase} />}
        </section>
      ) : (
        <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
          <nav aria-label="Collections" className="space-y-1">
            <button
              onClick={() => setCollectionId(null)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm ${collectionId === null ? "bg-[var(--muted)] font-medium" : "hover:bg-[var(--muted)]"}`}
            >
              All articles
            </button>
            {tree.map((c) => (
              <button
                key={c.id}
                onClick={() => setCollectionId(c.id)}
                style={{ paddingLeft: `${0.75 + c.depth}rem` }}
                className={`w-full text-left pr-3 py-2 rounded-lg text-sm flex items-center gap-2 ${
                  collectionId === c.id ? "bg-[var(--muted)] font-medium" : "hover:bg-[var(--muted)]"
                }`}
              >
                <Folder size={14} className="shrink-0 text-[var(--muted-foreground)]" />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-xs text-[var(--muted-foreground)]">{c.articleCount}</span>
              </button>
            ))}
            {tree.length > 0 && uncategorized > 0 && (
              <p className="px-3 pt-2 text-xs text-[var(--muted-foreground)]">{uncategorized} more in no collection</p>
            )}
          </nav>
          <section className="space-y-2">
            {current?.description && <p className="text-sm text-[var(--muted-foreground)]">{current.description}</p>}
            {articles === null ? (
              <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
            ) : visibleArticles.length === 0 ? (
              <p className="text-sm text-[var(--muted-foreground)] py-8 text-center">No articles here yet.</p>
            ) : (
              <ArticleList articles={visibleArticles} linkBase={source.linkBase} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** One article with its attachments, a helpfulness vote and related articles. */
export function KbArticleView({ source, slug }: { source: KbReaderSource; slug: string }) {
  const [article, setArticle] = useState<KbReaderArticle | null>(null);
  const [missing, setMissing] = useState(false);
  const [related, setRelated] = useState<KbArticleSummary[]>([]);
  const [vote, setVote] = useState<boolean | null>(null);
  const [voting, setVoting] = useState(false);
  const base = `${source.apiBase}/articles/${encodeURIComponent(slug)}`;

  useEffect(() => {
    setArticle(null);
    setMissing(false);
    apiFetch<KbReaderArticle>(base)
      .then((a) => {
        setArticle(a);
        setVote(a.myVote);
      })
      .catch(() => setMissing(true));
    apiFetch<KbArticleSummary[]>(`${base}/related`)
      .then(setRelated)
      .catch(() => setRelated([]));
  }, [base]);

  async function sendVote(helpful: boolean): Promise<void> {
    setVoting(true);
    try {
      await apiFetch(`${base}/feedback`, { method: "POST", body: JSON.stringify({ helpful }) });
      setVote(helpful);
    } catch {
      // A failed vote isn't worth interrupting the reader for.
    } finally {
      setVoting(false);
    }
  }

  if (missing) {
    return (
      <div className="py-12 text-center space-y-2">
        <p className="text-[var(--muted-foreground)]">This article isn&apos;t available.</p>
        <Link href={source.linkBase} className="text-sm hover:underline">
          Back to the help center
        </Link>
      </div>
    );
  }
  if (!article) return <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_16rem]">
      <article className="space-y-4 min-w-0">
        <Link href={source.linkBase} className="text-sm text-[var(--muted-foreground)] hover:underline">
          ‹ Help center{article.collection ? ` / ${article.collection.name}` : ""}
        </Link>
        <h1 className="text-2xl font-bold">{article.title}</h1>
        <p className="text-xs text-[var(--muted-foreground)]">Updated {formatDate(article.updatedAt)}</p>
        <Markdown source={kbBodyForDisplay(article.body, source.publicOrgSlug)} />

        {article.attachments.length > 0 && (
          <div className="space-y-1 pt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">Attachments</p>
            {article.attachments.map((att) => (
              <a
                key={att.id}
                href={kbAttachmentUrl(att.id, source.publicOrgSlug)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm hover:underline"
              >
                <Paperclip size={13} /> {att.filename}
              </a>
            ))}
          </div>
        )}

        <div className="border-t border-[var(--border)] pt-4 flex items-center gap-3 flex-wrap" aria-label="Feedback">
          <span className="text-sm">{vote === null ? "Was this helpful?" : "Thanks for your feedback."}</span>
          <button
            onClick={() => sendVote(true)}
            disabled={voting}
            aria-pressed={vote === true}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm ${
              vote === true ? "border-[var(--primary)] text-[var(--primary)]" : "border-[var(--border)] hover:bg-[var(--muted)]"
            }`}
          >
            <ThumbsUp size={14} /> Yes
          </button>
          <button
            onClick={() => sendVote(false)}
            disabled={voting}
            aria-pressed={vote === false}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm ${
              vote === false ? "border-[var(--primary)] text-[var(--primary)]" : "border-[var(--border)] hover:bg-[var(--muted)]"
            }`}
          >
            <ThumbsDown size={14} /> No
          </button>
        </div>
      </article>

      {related.length > 0 && (
        <aside className="space-y-2" aria-label="Related articles">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">Related articles</p>
          <ul className="space-y-1">
            {related.map((r) => (
              <li key={r.id}>
                <Link href={`${source.linkBase}/${r.slug}`} className="text-sm hover:underline">
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
