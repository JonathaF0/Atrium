"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { History, Paperclip, Trash2, X } from "lucide-react";
import { KB_VISIBILITIES, KB_VISIBILITY_LABELS } from "@atrium/shared";
import type { KbArticleStatus, KbVisibility } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { LabelPicker } from "@/components/label-picker";
import { LabelBadge } from "@/components/label-badge";
import { ProjectDetailSkeleton } from "@/components/skeletons";
import { KB_STATUS_LABELS, KB_STATUS_STYLES, flattenTree, kbAttachmentUrl } from "@/lib/kb";
import type { KbStaffCollection } from "@/lib/kb";
import { MarkdownEditor } from "./markdown-editor";
import { RevisionsDrawer } from "./revisions-drawer";
import { AudiencePicker } from "../../audience-picker";
import { buttonClass, inputClass, labelClass, primaryButtonClass, sectionTitleClass, selectClass } from "../../styles";

interface Label {
  id: string;
  name: string;
  color: string;
}

interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface Article {
  id: string;
  title: string;
  slug: string;
  body: string;
  status: KbArticleStatus;
  visibility: KbVisibility;
  effectiveVisibility: KbVisibility;
  collectionId: string | null;
  ownerId: string | null;
  reviewBy: string | null;
  version: number;
  sourceTicketId: string | null;
  audiences: { id: string; name: string }[];
  labels: Label[];
  attachments: Attachment[];
  revisionCount: number;
}

interface StaffMember {
  userId: string;
  name: string;
}

type Action = "submit" | "publish" | "unpublish" | "archive";

const ACTIONS: Record<KbArticleStatus, Array<{ action: Action; label: string; primary?: boolean }>> = {
  draft: [
    { action: "publish", label: "Publish", primary: true },
    { action: "submit", label: "Submit for review" },
    { action: "archive", label: "Archive" },
  ],
  in_review: [
    { action: "publish", label: "Approve and publish", primary: true },
    { action: "unpublish", label: "Back to draft" },
    { action: "archive", label: "Archive" },
  ],
  published: [
    { action: "unpublish", label: "Unpublish" },
    { action: "archive", label: "Archive" },
  ],
  archived: [{ action: "unpublish", label: "Restore as draft" }],
};

function toDateInput(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

export default function KbArticleEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const { success, error: showError } = useToast();
  const [article, setArticle] = useState<Article | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [collections, setCollections] = useState<KbStaffCollection[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [showRevisions, setShowRevisions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  // Editable fields
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [body, setBody] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [visibility, setVisibility] = useState<KbVisibility>("clients");
  const [audience, setAudience] = useState<string[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [reviewBy, setReviewBy] = useState("");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [revisionNote, setRevisionNote] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const a = await apiFetch<Article>(`/kb/articles/${id}`);
      setArticle(a);
      setTitle(a.title);
      setSlug(a.slug);
      setBody(a.body);
      setCollectionId(a.collectionId ?? "");
      setVisibility(a.visibility);
      setAudience(a.audiences.map((c) => c.id));
      setOwnerId(a.ownerId ?? "");
      setReviewBy(toDateInput(a.reviewBy));
      setLabelIds(a.labels.map((l) => l.id));
    } catch (err) {
      if (err instanceof Error && err.message === "Article not found") setNotFound(true);
      else showError(err instanceof Error ? err.message : "Failed to load article");
    }
  }, [id, showError]);

  useEffect(() => {
    load();
    apiFetch<KbStaffCollection[]>("/kb/collections").then(setCollections).catch(() => undefined);
    apiFetch<StaffMember[]>("/kb/staff").then(setStaff).catch(() => undefined);
    apiFetch<Label[]>("/labels").then(setAllLabels).catch(() => undefined);
  }, [load]);

  const dirty: boolean =
    !!article &&
    (title !== article.title ||
      slug !== article.slug ||
      body !== article.body ||
      collectionId !== (article.collectionId ?? "") ||
      visibility !== article.visibility ||
      ownerId !== (article.ownerId ?? "") ||
      reviewBy !== toDateInput(article.reviewBy) ||
      [...audience].sort().join() !== article.audiences.map((c) => c.id).sort().join() ||
      [...labelIds].sort().join() !== article.labels.map((l) => l.id).sort().join());

  async function save(): Promise<boolean> {
    if (!article || !title.trim()) return false;
    setSaving(true);
    try {
      await apiFetch(`/kb/articles/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          ...(slug !== article.slug ? { slug } : {}),
          body,
          collectionId: collectionId || null,
          visibility,
          audienceCompanyIds: visibility === "restricted" ? audience : [],
          ownerId: ownerId || null,
          reviewBy: reviewBy ? new Date(`${reviewBy}T00:00:00Z`).toISOString() : null,
          labelIds,
          ...(revisionNote.trim() ? { revisionNote: revisionNote.trim() } : {}),
        }),
      });
      setRevisionNote("");
      await load();
      success("Article saved");
      return true;
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save article");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function transition(action: Action): Promise<void> {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      await apiFetch(`/kb/articles/${id}/${action}`, { method: "POST" });
      await load();
      success(action === "publish" ? "Article published" : "Status updated");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!article) return;
    const ok = await confirm({
      title: "Delete article",
      message: `Delete "${article.title}" and its history? This can't be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/kb/articles/${id}`, { method: "DELETE" });
      router.push("/dashboard/kb");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete article");
    }
  }

  async function upload(file: File): Promise<string | null> {
    const form = new FormData();
    form.append("file", file);
    try {
      const att = await apiFetch<Attachment & { url: string }>(`/kb/articles/${id}/attachments`, { method: "POST", body: form });
      setArticle((a) => (a ? { ...a, attachments: [...a.attachments, att] } : a));
      const name: string = att.filename.replace(/[[\]]/g, "");
      return att.mimeType.startsWith("image/") ? `![${name}](${att.url})` : `[${name}](${att.url})`;
    } catch (err) {
      showError(err instanceof Error ? err.message : "Upload failed");
      return null;
    }
  }

  async function removeAttachment(att: Attachment): Promise<void> {
    try {
      await apiFetch(`/kb/articles/${id}/attachments/${att.id}`, { method: "DELETE" });
      setArticle((a) => (a ? { ...a, attachments: a.attachments.filter((x) => x.id !== att.id) } : a));
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to remove attachment");
    }
  }

  if (notFound) {
    return (
      <div className="py-12 text-center space-y-2">
        <p className="text-[var(--muted-foreground)]">Article not found.</p>
        <Link href="/dashboard/kb" className="text-sm hover:underline">
          Back to knowledge base
        </Link>
      </div>
    );
  }
  if (!article) return <ProjectDetailSkeleton />;

  const versioned: boolean = article.status === "published" || article.status === "in_review";
  const stricter: boolean = article.effectiveVisibility !== article.visibility;

  return (
    <div className="space-y-4">
      <Link href="/dashboard/kb" className="text-sm text-[var(--muted-foreground)] hover:underline">
        ‹ Knowledge base
      </Link>

      <div className="flex items-start gap-3 flex-wrap">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          aria-label="Title"
          className="flex-1 min-w-[16rem] text-2xl font-bold bg-transparent outline-none border-b border-transparent focus:border-[var(--border)]"
        />
        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium mt-2 ${KB_STATUS_STYLES[article.status]}`} data-testid="kb-status">
          {KB_STATUS_LABELS[article.status]}
        </span>
        <span className="text-xs text-[var(--muted-foreground)] mt-2">v{article.version}</span>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={save} disabled={saving || !dirty || !title.trim()} className={primaryButtonClass}>
          {saving ? "Saving..." : "Save"}
        </button>
        {ACTIONS[article.status].map((a) => (
          <button
            key={a.action}
            onClick={() => transition(a.action)}
            disabled={busy || saving}
            className={a.primary ? primaryButtonClass : buttonClass}
          >
            {a.label}
          </button>
        ))}
        <button onClick={() => setShowRevisions(true)} className={`${buttonClass} inline-flex items-center gap-1.5`}>
          <History size={15} /> Revisions ({article.revisionCount})
        </button>
        {article.status === "published" && (
          <Link href={`/portal/kb/${article.slug}`} target="_blank" className="text-sm text-[var(--primary)] hover:underline">
            View as reader
          </Link>
        )}
        <button onClick={remove} className={`${buttonClass} text-red-600 ml-auto inline-flex items-center gap-1.5`}>
          <Trash2 size={15} /> Delete
        </button>
      </div>
      {versioned && dirty && (
        <input
          value={revisionNote}
          onChange={(e) => setRevisionNote(e.target.value)}
          maxLength={300}
          placeholder="What changed? (saved with this revision)"
          aria-label="Revision note"
          className={`${inputClass} max-w-xl`}
        />
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
        <MarkdownEditor value={body} onChange={setBody} onUpload={upload} />

        <aside className="space-y-4 text-sm">
          <div>
            <label htmlFor="kb-slug" className={labelClass}>
              Slug
            </label>
            <input
              id="kb-slug"
              value={slug}
              maxLength={80}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="kb-collection" className={labelClass}>
              Collection
            </label>
            <select id="kb-collection" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} className={`${selectClass} w-full`}>
              <option value="">None</option>
              {flattenTree(collections).map((c) => (
                <option key={c.id} value={c.id}>
                  {"  ".repeat(c.depth)}
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="kb-visibility" className={labelClass}>
              Visibility
            </label>
            <select
              id="kb-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as KbVisibility)}
              className={`${selectClass} w-full`}
            >
              {KB_VISIBILITIES.map((v) => (
                <option key={v} value={v}>
                  {KB_VISIBILITY_LABELS[v]}
                </option>
              ))}
            </select>
            {stricter && (
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                Its collection makes it {KB_VISIBILITY_LABELS[article.effectiveVisibility].toLowerCase()}.
              </p>
            )}
          </div>
          {visibility === "restricted" && (
            <div>
              <span className={labelClass}>Companies that can read it</span>
              <AudiencePicker selected={audience} onChange={setAudience} />
            </div>
          )}
          <div>
            <label htmlFor="kb-owner" className={labelClass}>
              Owner
            </label>
            <select id="kb-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={`${selectClass} w-full`}>
              <option value="">No owner</option>
              {staff.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="kb-review" className={labelClass}>
              Review by
            </label>
            <input id="kb-review" type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} className={inputClass} />
          </div>
          <div>
            <span className={labelClass}>Tags</span>
            <div className="flex flex-wrap gap-1 items-center">
              {allLabels
                .filter((l) => labelIds.includes(l.id))
                .map((l) => (
                  <LabelBadge key={l.id} name={l.name} color={l.color} />
                ))}
              <LabelPicker
                labels={allLabels}
                assigned={labelIds}
                onToggle={(labelId) =>
                  setLabelIds((ids) => (ids.includes(labelId) ? ids.filter((x) => x !== labelId) : [...ids, labelId]))
                }
              />
            </div>
          </div>
          {article.attachments.length > 0 && (
            <div>
              <p className={`${sectionTitleClass} mb-2`}>Attachments</p>
              <ul className="space-y-1">
                {article.attachments.map((att) => (
                  <li key={att.id} className="flex items-center gap-2">
                    <Paperclip size={13} className="shrink-0 text-[var(--muted-foreground)]" />
                    <a href={kbAttachmentUrl(att.id)} target="_blank" rel="noopener noreferrer" className="truncate flex-1 hover:underline">
                      {att.filename}
                    </a>
                    <button onClick={() => removeAttachment(att)} aria-label={`Remove ${att.filename}`} className="text-[var(--muted-foreground)] hover:text-red-600">
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {article.sourceTicketId && (
            <p className="text-xs text-[var(--muted-foreground)]">Drafted from a resolved ticket.</p>
          )}
        </aside>
      </div>

      {showRevisions && (
        <RevisionsDrawer
          articleId={article.id}
          onClose={() => setShowRevisions(false)}
          onRestored={async () => {
            setShowRevisions(false);
            await load();
          }}
        />
      )}
    </div>
  );
}
