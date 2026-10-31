"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { Markdown } from "@/components/markdown";
import { kbBodyForDisplay } from "@/lib/kb";

interface Revision {
  id: string;
  version: number;
  title: string;
  body: string;
  note: string | null;
  createdAt: string;
  author: { id: string; name: string } | null;
}

/** Side panel listing an article's versions; restoring one adds a new version. */
export function RevisionsDrawer({
  articleId,
  onClose,
  onRestored,
}: {
  articleId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [selected, setSelected] = useState<Revision | null>(null);

  useEffect(() => {
    apiFetch<Revision[]>(`/kb/articles/${articleId}/revisions`)
      .then((rows) => {
        setRevisions(rows);
        setSelected(rows[0] ?? null);
      })
      .catch(() => setRevisions([]));
  }, [articleId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function restore(rev: Revision): Promise<void> {
    const ok = await confirm({
      title: `Restore version ${rev.version}`,
      message: "Its title and body replace the current ones, saved as a new version. Nothing is lost.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    try {
      await apiFetch(`/kb/articles/${articleId}/revisions/${rev.id}/restore`, { method: "POST", body: JSON.stringify({}) });
      success(`Restored version ${rev.version}`);
      onRestored();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to restore");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Revisions"
        className="w-full max-w-3xl h-full bg-[var(--background)] border-l border-[var(--border)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h2 className="font-semibold">Revisions</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-[var(--muted)]">
            <X size={18} />
          </button>
        </div>
        {revisions === null ? (
          <p className="p-4 text-sm text-[var(--muted-foreground)]">Loading...</p>
        ) : revisions.length === 0 ? (
          <p className="p-4 text-sm text-[var(--muted-foreground)]">
            No revisions yet. Versions are recorded when an article is submitted, published, and edited after that.
          </p>
        ) : (
          <div className="flex-1 grid md:grid-cols-[14rem_1fr] min-h-0">
            <ul className="border-r border-[var(--border)] overflow-y-auto divide-y divide-[var(--border)]">
              {revisions.map((r, i) => (
                <li key={r.id}>
                  <button
                    onClick={() => setSelected(r)}
                    className={`w-full text-left px-4 py-3 text-sm hover:bg-[var(--muted)] ${selected?.id === r.id ? "bg-[var(--muted)]" : ""}`}
                  >
                    <span className="font-medium">Version {r.version}</span>
                    {i === 0 && <span className="ml-2 text-xs text-[var(--muted-foreground)]">latest</span>}
                    <span className="block text-xs text-[var(--muted-foreground)]">
                      {new Date(r.createdAt).toLocaleString()}
                      {r.author ? ` · ${r.author.name}` : ""}
                    </span>
                    {r.note && <span className="block text-xs mt-1 truncate">{r.note}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {selected && (
              <div className="overflow-y-auto p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-lg font-semibold">{selected.title}</h3>
                  {selected.id !== revisions[0].id && (
                    <button
                      onClick={() => restore(selected)}
                      className="px-3 py-1.5 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]"
                    >
                      Restore this version
                    </button>
                  )}
                </div>
                <Markdown source={kbBodyForDisplay(selected.body)} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
