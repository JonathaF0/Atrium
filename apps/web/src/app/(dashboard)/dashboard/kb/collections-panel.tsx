"use client";

import { useCallback, useEffect, useState } from "react";
import { KB_VISIBILITIES, KB_VISIBILITY_LABELS } from "@atrium/shared";
import type { KbVisibility } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { flattenTree } from "@/lib/kb";
import type { KbStaffCollection } from "@/lib/kb";
import { AudiencePicker } from "./audience-picker";
import { buttonClass, inputClass, labelClass, primaryButtonClass, selectClass } from "./styles";

interface Draft {
  id: string | null;
  name: string;
  description: string;
  parentId: string;
  visibility: KbVisibility;
  order: number;
  audienceCompanyIds: string[];
}

const EMPTY: Draft = { id: null, name: "", description: "", parentId: "", visibility: "clients", order: 0, audienceCompanyIds: [] };

export function CollectionsPanel() {
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [collections, setCollections] = useState<KbStaffCollection[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setCollections(await apiFetch<KbStaffCollection[]>("/kb/collections"));
    } catch {
      setCollections([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      parentId: draft.parentId || null,
      visibility: draft.visibility,
      order: draft.order,
      audienceCompanyIds: draft.visibility === "restricted" ? draft.audienceCompanyIds : [],
    };
    try {
      if (draft.id) {
        await apiFetch(`/kb/collections/${draft.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await apiFetch("/kb/collections", { method: "POST", body: JSON.stringify(body) });
      }
      success(draft.id ? "Collection updated" : "Collection created");
      setDraft(null);
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save collection");
    } finally {
      setSaving(false);
    }
  }

  async function remove(c: KbStaffCollection): Promise<void> {
    const ok = await confirm({
      title: "Delete collection",
      message: `Delete "${c.name}"? Only empty collections can be deleted.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/kb/collections/${c.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete collection");
    }
  }

  const tree = flattenTree(collections ?? []);
  // A collection can't be moved under itself or its descendants.
  const invalidParents = new Set<string>();
  if (draft?.id) {
    let inside = false;
    let depth = 0;
    for (const c of tree) {
      if (c.id === draft.id) {
        inside = true;
        depth = c.depth;
        invalidParents.add(c.id);
        continue;
      }
      if (inside && c.depth > depth) invalidParents.add(c.id);
      else inside = false;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-[var(--muted-foreground)]">
          An article is shown with the strictest visibility of itself and every collection above it.
        </p>
        {!draft && (
          <button onClick={() => setDraft({ ...EMPTY })} className={primaryButtonClass}>
            New collection
          </button>
        )}
      </div>

      {draft && (
        <form onSubmit={save} className="border border-[var(--border)] rounded-xl p-4 space-y-3" aria-label="Collection form">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="kb-col-name" className={labelClass}>
                Name
              </label>
              <input
                id="kb-col-name"
                value={draft.name}
                maxLength={120}
                required
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="kb-col-parent" className={labelClass}>
                Parent
              </label>
              <select
                id="kb-col-parent"
                value={draft.parentId}
                onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}
                className={`${selectClass} w-full`}
              >
                <option value="">None (top level)</option>
                {tree
                  .filter((c) => !invalidParents.has(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {"  ".repeat(c.depth)}
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="kb-col-visibility" className={labelClass}>
                Visibility
              </label>
              <select
                id="kb-col-visibility"
                value={draft.visibility}
                onChange={(e) => setDraft({ ...draft, visibility: e.target.value as KbVisibility })}
                className={`${selectClass} w-full`}
              >
                {KB_VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {KB_VISIBILITY_LABELS[v]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="kb-col-order" className={labelClass}>
                Order
              </label>
              <input
                id="kb-col-order"
                type="number"
                min={0}
                max={100000}
                value={draft.order}
                onChange={(e) => setDraft({ ...draft, order: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label htmlFor="kb-col-description" className={labelClass}>
              Description
            </label>
            <textarea
              id="kb-col-description"
              value={draft.description}
              maxLength={1000}
              rows={2}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className={inputClass}
            />
          </div>
          {draft.visibility === "restricted" && (
            <div>
              <span className={labelClass}>Companies that can read this collection</span>
              <AudiencePicker
                selected={draft.audienceCompanyIds}
                onChange={(ids) => setDraft({ ...draft, audienceCompanyIds: ids })}
              />
            </div>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={saving || !draft.name.trim()} className={primaryButtonClass}>
              {saving ? "Saving..." : "Save collection"}
            </button>
            <button type="button" onClick={() => setDraft(null)} className={buttonClass}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {collections === null ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
      ) : tree.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)] py-8 text-center">No collections yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl">
          {tree.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3 text-sm" style={{ paddingLeft: `${1 + c.depth * 1.25}rem` }}>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{c.name}</p>
                <p className="text-xs text-[var(--muted-foreground)]">
                  {KB_VISIBILITY_LABELS[c.visibility] ?? c.visibility}
                  {c.visibility === "restricted" && c.audiences.length > 0 && `: ${c.audiences.map((a) => a.name).join(", ")}`}
                  {" · "}
                  {c.articleCount} {c.articleCount === 1 ? "article" : "articles"}
                </p>
              </div>
              <button
                onClick={() =>
                  setDraft({
                    id: c.id,
                    name: c.name,
                    description: c.description ?? "",
                    parentId: c.parentId ?? "",
                    visibility: c.visibility,
                    order: c.order,
                    audienceCompanyIds: c.audiences.map((a) => a.id),
                  })
                }
                className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                Edit
              </button>
              <button onClick={() => remove(c)} className="text-sm text-red-600 hover:underline">
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
