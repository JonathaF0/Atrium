"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EyeOff, ExternalLink, Paperclip, ShieldAlert, X } from "lucide-react";
import { CLIENT_DOC_SECTIONS, CLIENT_DOC_SECTION_LABELS } from "@atrium/shared";
import type { ClientDocSection } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { Markdown } from "@/components/markdown";
import { inputClass } from "../../shared";

const API_URL: string = process.env.NEXT_PUBLIC_API_URL || "";

interface ClientDoc {
  id: string;
  section: ClientDocSection;
  title: string;
  body: string;
  vaultUrl: string | null;
  clientVisible: boolean;
  order: number;
  updatedAt: string;
  attachments: { id: string; filename: string }[];
}

interface Draft {
  id: string | null;
  section: ClientDocSection;
  title: string;
  body: string;
  vaultUrl: string;
  clientVisible: boolean;
}

const EMPTY: Draft = { id: null, section: "network", title: "", body: "", vaultUrl: "", clientVisible: true };
const buttonClass = "px-3 py-1.5 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)] disabled:opacity-40";
const sectionTitleClass = "text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]";

/** Environment documentation for one client company (staff view). */
export function CompanyDocsSection({ companyId }: { companyId: string }) {
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [docs, setDocs] = useState<ClientDoc[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setDocs(await apiFetch<ClientDoc[]>(`/client-docs?companyId=${encodeURIComponent(companyId)}`));
    } catch {
      setDocs([]);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!draft || !draft.title.trim()) return;
    setSaving(true);
    const body = {
      section: draft.section,
      title: draft.title.trim(),
      body: draft.body,
      vaultUrl: draft.vaultUrl.trim() || null,
      clientVisible: draft.clientVisible,
    };
    try {
      if (draft.id) {
        await apiFetch(`/client-docs/${draft.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await apiFetch("/client-docs", { method: "POST", body: JSON.stringify({ ...body, companyId }) });
      }
      success("Document saved");
      setDraft(null);
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save document");
    } finally {
      setSaving(false);
    }
  }

  async function remove(doc: ClientDoc): Promise<void> {
    const ok = await confirm({
      title: "Delete document",
      message: `Delete "${doc.title}" and its attachments?`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/client-docs/${doc.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete document");
    }
  }

  async function upload(file: File): Promise<void> {
    const docId: string | null = uploadFor.current;
    if (!docId) return;
    const form = new FormData();
    form.append("file", file);
    try {
      await apiFetch(`/client-docs/${docId}/attachments`, { method: "POST", body: form });
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      uploadFor.current = null;
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeAttachment(docId: string, attachmentId: string): Promise<void> {
    try {
      await apiFetch(`/client-docs/${docId}/attachments/${attachmentId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to remove attachment");
    }
  }

  const grouped = CLIENT_DOC_SECTIONS.map((section) => ({
    section,
    docs: (docs ?? []).filter((d) => d.section === section),
  })).filter((g) => g.docs.length > 0);

  return (
    <section className="space-y-3" aria-label="Documentation">
      <div className="flex items-center justify-between">
        <h2 className={sectionTitleClass}>Documentation</h2>
        {!draft && (
          <button onClick={() => setDraft({ ...EMPTY })} className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            + Add document
          </button>
        )}
      </div>
      <p className="text-xs text-[var(--muted-foreground)] flex items-center gap-1.5">
        <ShieldAlert size={13} /> Never store passwords or keys here. Keep them in your password vault and paste the vault link.
      </p>

      {draft && (
        <form onSubmit={save} className="border border-[var(--border)] rounded-xl p-4 space-y-3" aria-label="Document form">
          <div className="grid gap-3 md:grid-cols-[12rem_1fr]">
            <select
              value={draft.section}
              onChange={(e) => setDraft({ ...draft, section: e.target.value as ClientDocSection })}
              aria-label="Section"
              className={inputClass}
            >
              {CLIENT_DOC_SECTIONS.map((s) => (
                <option key={s} value={s}>
                  {CLIENT_DOC_SECTION_LABELS[s]}
                </option>
              ))}
            </select>
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Title"
              aria-label="Document title"
              maxLength={200}
              required
              className={inputClass}
            />
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder="Markdown: network layout, steps, vendor contacts..."
            aria-label="Document body"
            rows={8}
            maxLength={50000}
            className={`${inputClass} font-mono`}
          />
          <input
            value={draft.vaultUrl}
            onChange={(e) => setDraft({ ...draft, vaultUrl: e.target.value })}
            placeholder="https:// link to the password vault entry (optional)"
            aria-label="Vault link"
            type="url"
            maxLength={2000}
            className={inputClass}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.clientVisible}
              onChange={(e) => setDraft({ ...draft, clientVisible: e.target.checked })}
            />
            Visible to the client in their portal
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving || !draft.title.trim()}
              className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-40"
            >
              {saving ? "Saving..." : "Save document"}
            </button>
            <button type="button" onClick={() => setDraft(null)} className={buttonClass}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload(file);
        }}
      />

      {docs === null ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
      ) : docs.length === 0 ? (
        !draft && <p className="text-sm text-[var(--muted-foreground)]">No documentation yet.</p>
      ) : (
        grouped.map(({ section, docs: list }) => (
          <div key={section} className="space-y-2">
            <p className="text-xs text-[var(--muted-foreground)]">{CLIENT_DOC_SECTION_LABELS[section]}</p>
            {list.map((doc) => (
              <details key={doc.id} className="border border-[var(--border)] rounded-xl">
                <summary className="cursor-pointer px-4 py-3 flex items-center gap-2 text-sm">
                  <span className="font-medium flex-1">{doc.title}</span>
                  {!doc.clientVisible && (
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                      <EyeOff size={12} /> Staff only
                    </span>
                  )}
                </summary>
                <div className="px-4 pb-4 space-y-3">
                  {doc.body && <Markdown source={doc.body} />}
                  {doc.vaultUrl && (
                    <a
                      href={doc.vaultUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 text-sm text-[var(--primary)] hover:underline"
                    >
                      Vault entry <ExternalLink size={13} />
                    </a>
                  )}
                  {doc.attachments.length > 0 && (
                    <ul className="space-y-1">
                      {doc.attachments.map((att) => (
                        <li key={att.id} className="flex items-center gap-2 text-sm">
                          <Paperclip size={13} className="text-[var(--muted-foreground)]" />
                          <a
                            href={`${API_URL}/api/client-docs/attachments/${att.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            {att.filename}
                          </a>
                          <button
                            onClick={() => removeAttachment(doc.id, att.id)}
                            aria-label={`Remove ${att.filename}`}
                            className="text-[var(--muted-foreground)] hover:text-red-600"
                          >
                            <X size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        setDraft({
                          id: doc.id,
                          section: doc.section,
                          title: doc.title,
                          body: doc.body,
                          vaultUrl: doc.vaultUrl ?? "",
                          clientVisible: doc.clientVisible,
                        })
                      }
                      className={buttonClass}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        uploadFor.current = doc.id;
                        fileRef.current?.click();
                      }}
                      className={buttonClass}
                    >
                      Attach file
                    </button>
                    <button onClick={() => remove(doc)} className={`${buttonClass} text-red-600`}>
                      Delete
                    </button>
                  </div>
                </div>
              </details>
            ))}
          </div>
        ))
      )}
    </section>
  );
}
