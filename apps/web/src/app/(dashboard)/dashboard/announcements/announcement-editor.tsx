"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";
import { ASSET_TYPES, CONTRACT_TYPES } from "@atrium/shared";
import { apiFetch, fetchAllPages } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  ANNOUNCEMENT_TYPE_LABELS,
  AUDIENCE_LABELS,
  SEVERITY_LABELS,
} from "@/lib/announcements";

export interface AnnouncementDetail {
  id: string;
  type: string;
  severity: string;
  status: string;
  incidentState: string | null;
  title: string;
  body: string;
  impact: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  publishAt: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  resolvedAt: string | null;
  postmortem: string | null;
  audienceType: string;
  audienceValue: string | null;
  categoryIds: string[];
  publicStatus: boolean;
  emailOnPublish: boolean;
  pushOnPublish: boolean;
  audiences: { companyId: string; company: { id: string; name: string } }[];
  updates: { id: string; state: string | null; body: string; createdAt: string }[];
}

interface Template {
  id: string;
  name: string;
  type: string;
  severity: string;
  title: string;
  body: string;
}

interface FormState {
  type: string;
  severity: string;
  title: string;
  body: string;
  impact: string;
  windowStart: string;
  windowEnd: string;
  expiresAt: string;
  audienceType: string;
  audienceValue: string;
  companyIds: string[];
  publicStatus: boolean;
  emailOnPublish: boolean;
  pushOnPublish: boolean;
}

export const inputClass =
  "w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";
const labelClass = "block text-sm font-medium mb-1";

/** ISO → value for <input type="datetime-local"> in the browser's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

function initialState(a?: AnnouncementDetail): FormState {
  return {
    type: a?.type ?? "general",
    severity: a?.severity ?? "info",
    title: a?.title ?? "",
    body: a?.body ?? "",
    impact: a?.impact ?? "",
    windowStart: toLocalInput(a?.windowStart ?? null),
    windowEnd: toLocalInput(a?.windowEnd ?? null),
    expiresAt: toLocalInput(a?.expiresAt ?? null),
    audienceType: a?.audienceType ?? "all",
    audienceValue: a?.audienceValue ?? "",
    companyIds: a?.audiences.map((x) => x.companyId) ?? [],
    publicStatus: a?.publicStatus ?? false,
    emailOnPublish: a?.emailOnPublish ?? false,
    pushOnPublish: a?.pushOnPublish ?? false,
  };
}

function audiencePayload(form: FormState): Record<string, unknown> {
  return {
    audienceType: form.audienceType,
    audienceValue: form.audienceType === "contracts" || form.audienceType === "assets" ? form.audienceValue : null,
    companyIds: form.audienceType === "companies" ? form.companyIds : [],
  };
}

/** Create or edit an announcement: content, audience (with a live recipient count) and delivery options. */
export function AnnouncementEditor({
  announcement,
  onSaved,
}: {
  announcement?: AnnouncementDetail;
  onSaved?: (a: AnnouncementDetail) => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => initialState(announcement));
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [companyFilter, setCompanyFilter] = useState("");
  const [preview, setPreview] = useState<{ companyCount: number; recipientCount: number } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const isNew = !announcement;

  useEffect(() => {
    if (isNew) {
      apiFetch<Template[]>("/announcements/templates").then(setTemplates).catch(() => {});
    }
    fetchAllPages<{ id: string; name: string }>("/companies")
      .then(setCompanies)
      .catch(() => {});
  }, [isNew]);

  const audienceKey = JSON.stringify(audiencePayload(form));
  useEffect(() => {
    const payload = JSON.parse(audienceKey) as Record<string, unknown>;
    const incomplete =
      (payload.audienceType === "companies" && (payload.companyIds as string[]).length === 0) ||
      ((payload.audienceType === "contracts" || payload.audienceType === "assets") &&
        !String(payload.audienceValue ?? "").trim());
    if (incomplete) {
      setPreview(null);
      setPreviewError("");
      return;
    }
    const timer = setTimeout(() => {
      apiFetch<{ companyCount: number; recipientCount: number }>("/announcements/audience-preview", {
        method: "POST",
        body: audienceKey,
      })
        .then((res) => {
          setPreview(res);
          setPreviewError("");
        })
        .catch((err) => {
          setPreview(null);
          setPreviewError(err instanceof Error ? err.message : "Preview failed");
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [audienceKey]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => setForm((f) => ({ ...f, [key]: value }));

  const applyTemplate = (id: string): void => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) setForm((f) => ({ ...f, type: t.type, severity: t.severity, title: t.title, body: t.body }));
  };

  const visibleCompanies = useMemo(() => {
    const q = companyFilter.trim().toLowerCase();
    return q ? companies.filter((c) => c.name.toLowerCase().includes(q)) : companies;
  }, [companies, companyFilter]);

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        type: form.type,
        severity: form.severity,
        title: form.title,
        body: form.body,
        impact: form.impact.trim() || null,
        windowStart: form.type === "maintenance" ? fromLocalInput(form.windowStart) : null,
        windowEnd: form.type === "maintenance" ? fromLocalInput(form.windowEnd) : null,
        expiresAt: fromLocalInput(form.expiresAt),
        publicStatus: form.audienceType === "all" ? form.publicStatus : false,
        emailOnPublish: form.emailOnPublish,
        pushOnPublish: form.pushOnPublish,
        ...audiencePayload(form),
      };
      if (isNew && templateId) payload.templateId = templateId;
      const saved = await apiFetch<AnnouncementDetail>(isNew ? "/announcements" : `/announcements/${announcement.id}`, {
        method: isNew ? "POST" : "PUT",
        body: JSON.stringify(payload),
      });
      toast.success(isNew ? "Announcement created" : "Announcement saved");
      if (isNew) router.replace(`/dashboard/announcements/${saved.id}`);
      else onSaved?.(saved);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-5 max-w-2xl" aria-label="Announcement">
      {isNew && templates.length > 0 && (
        <div>
          <label htmlFor="ann-template" className={labelClass}>
            Start from template
          </label>
          <select id="ann-template" value={templateId} onChange={(e) => applyTemplate(e.target.value)} className={inputClass}>
            <option value="">Blank</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ann-type" className={labelClass}>
            Type
          </label>
          <select id="ann-type" value={form.type} onChange={(e) => set("type", e.target.value)} className={inputClass}>
            {Object.entries(ANNOUNCEMENT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ann-severity" className={labelClass}>
            Severity
          </label>
          <select id="ann-severity" value={form.severity} onChange={(e) => set("severity", e.target.value)} className={inputClass}>
            {Object.entries(SEVERITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="ann-title" className={labelClass}>
          Title
        </label>
        <input
          id="ann-title"
          required
          maxLength={200}
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="ann-body" className={labelClass}>
          Message <span className="font-normal text-[var(--muted-foreground)]">(Markdown)</span>
        </label>
        <textarea
          id="ann-body"
          rows={6}
          maxLength={20000}
          value={form.body}
          onChange={(e) => set("body", e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="ann-impact" className={labelClass}>
          Impact <span className="font-normal text-[var(--muted-foreground)]">(optional)</span>
        </label>
        <input
          id="ann-impact"
          maxLength={500}
          value={form.impact}
          onChange={(e) => set("impact", e.target.value)}
          placeholder="e.g. Email may be delayed for up to 15 minutes"
          className={inputClass}
        />
      </div>

      {form.type === "maintenance" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ann-window-start" className={labelClass}>
              Window starts
            </label>
            <input
              id="ann-window-start"
              type="datetime-local"
              value={form.windowStart}
              onChange={(e) => set("windowStart", e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="ann-window-end" className={labelClass}>
              Window ends
            </label>
            <input
              id="ann-window-end"
              type="datetime-local"
              value={form.windowEnd}
              onChange={(e) => set("windowEnd", e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
      )}

      <div>
        <label htmlFor="ann-expires" className={labelClass}>
          Expires <span className="font-normal text-[var(--muted-foreground)]">(optional)</span>
        </label>
        <input
          id="ann-expires"
          type="datetime-local"
          value={form.expiresAt}
          onChange={(e) => set("expiresAt", e.target.value)}
          className={inputClass}
        />
      </div>

      <fieldset className="border border-[var(--border)] rounded-lg p-4 space-y-3">
        <legend className="text-sm font-medium px-1">Audience</legend>
        <select
          aria-label="Audience"
          value={form.audienceType}
          onChange={(e) => setForm((f) => ({ ...f, audienceType: e.target.value, audienceValue: "" }))}
          className={inputClass}
        >
          {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        {form.audienceType === "companies" && (
          <div>
            <input
              aria-label="Filter companies"
              placeholder="Filter companies..."
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value)}
              className={`${inputClass} mb-2`}
            />
            <div className="max-h-48 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
              {visibleCompanies.length === 0 && (
                <p className="text-sm text-[var(--muted-foreground)] p-3">No companies.</p>
              )}
              {visibleCompanies.map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={form.companyIds.includes(c.id)}
                    onChange={(e) =>
                      set(
                        "companyIds",
                        e.target.checked ? [...form.companyIds, c.id] : form.companyIds.filter((id) => id !== c.id),
                      )
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {form.audienceType === "contracts" && (
          <div>
            <input
              aria-label="Contract type or included service"
              list="ann-contract-types"
              maxLength={100}
              placeholder="Contract type (e.g. sla) or included service"
              value={form.audienceValue}
              onChange={(e) => set("audienceValue", e.target.value)}
              className={inputClass}
            />
            <datalist id="ann-contract-types">
              {CONTRACT_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <p className="text-xs text-[var(--muted-foreground)] mt-1">
              Companies with an active contract of this type, or one that includes this service.
            </p>
          </div>
        )}

        {form.audienceType === "assets" && (
          <div>
            <input
              aria-label="Asset vendor or type"
              list="ann-asset-types"
              maxLength={100}
              placeholder="Vendor or asset type"
              value={form.audienceValue}
              onChange={(e) => set("audienceValue", e.target.value)}
              className={inputClass}
            />
            <datalist id="ann-asset-types">
              {ASSET_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <p className="text-xs text-[var(--muted-foreground)] mt-1">
              Companies with an active asset from this vendor or of this type (not case-sensitive).
            </p>
          </div>
        )}

        <p className="text-sm flex items-center gap-2" data-testid="audience-preview">
          <Users size={14} className="text-[var(--muted-foreground)]" />
          {previewError ? (
            <span className="text-red-600">{previewError}</span>
          ) : preview ? (
            <span>
              Reaches {preview.companyCount} {preview.companyCount === 1 ? "company" : "companies"} and{" "}
              {preview.recipientCount} {preview.recipientCount === 1 ? "portal user" : "portal users"}
            </span>
          ) : (
            <span className="text-[var(--muted-foreground)]">Choose an audience to see who it reaches</span>
          )}
        </p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium mb-1">Delivery</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.emailOnPublish} onChange={(e) => set("emailOnPublish", e.target.checked)} />
          Email the audience when published (and on incident updates)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.pushOnPublish} onChange={(e) => set("pushOnPublish", e.target.checked)} />
          Send a push notification
        </label>
        <label className={`flex items-center gap-2 text-sm ${form.audienceType !== "all" ? "opacity-50" : ""}`}>
          <input
            type="checkbox"
            disabled={form.audienceType !== "all"}
            checked={form.audienceType === "all" && form.publicStatus}
            onChange={(e) => set("publicStatus", e.target.checked)}
          />
          Show on the public status page
          {form.audienceType !== "all" && <span className="text-xs">(only for announcements to all clients)</span>}
        </label>
      </fieldset>

      <button
        type="submit"
        disabled={saving}
        className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-50"
      >
        {saving ? "Saving..." : isNew ? "Create draft" : "Save changes"}
      </button>
    </form>
  );
}

