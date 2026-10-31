"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { TICKET_LEVELS } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { uploadAttachments } from "@/lib/tickets";
import { TicketFormSuggestions } from "@/components/ticket-form-suggestions";

interface Category {
  id: string;
  name: string;
  description: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
}

const LEVEL_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };
const MAX_FILES = 10;

export default function NewTicketPage(): React.ReactElement {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [subject, setSubject] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [impact, setImpact] = useState("medium");
  const [urgency, setUrgency] = useState("medium");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<Category[]>("/tickets/mine/categories").then(setCategories).catch(() => setCategories([]));
    apiFetch<{ data: ProjectOption[] }>("/projects/mine?limit=100")
      .then((res) => setProjects(res.data))
      .catch(() => setProjects([]));
  }, []);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const ticket = await apiFetch<{ id: string; messages: { id: string }[] }>("/tickets/mine", {
        method: "POST",
        body: JSON.stringify({
          subject: subject.trim(),
          description,
          impact,
          urgency,
          ...(categoryId ? { categoryId } : {}),
          ...(projectId ? { projectId } : {}),
        }),
      });
      if (files.length > 0 && ticket.messages[0]) {
        const failed = await uploadAttachments(`/tickets/mine/${ticket.id}`, ticket.messages[0].id, files);
        if (failed.length > 0) {
          router.push(`/portal/tickets/${ticket.id}?uploadFailed=${failed.length}`);
          return;
        }
      }
      router.push(`/portal/tickets/${ticket.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the request");
      setSubmitting(false);
    }
  };

  const selected = categories.find((c) => c.id === categoryId);
  const inputClass = "w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";

  return (
    <div className="max-w-2xl">
      <Link href="/portal/tickets" className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] mb-4">
        <ArrowLeft size={14} /> Back to requests
      </Link>
      <h1 className="text-2xl font-bold mb-6">New support request</h1>
      {error && <div className="mb-4 p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}
      <form onSubmit={submit} className="space-y-5">
        <div>
          <label htmlFor="ticket-subject" className="block text-sm font-medium mb-1">
            Subject
          </label>
          <input
            id="ticket-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            minLength={3}
            maxLength={200}
            className={inputClass}
            placeholder="Short summary of the problem"
          />
          <TicketFormSuggestions subject={subject} categoryId={categoryId || undefined} />
        </div>

        <div>
          <label htmlFor="ticket-category" className="block text-sm font-medium mb-1">
            Category
          </label>
          <select id="ticket-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
            <option value="">Choose a category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {selected?.description && <p className="mt-1 text-xs text-[var(--muted-foreground)]">{selected.description}</p>}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="ticket-impact" className="block text-sm font-medium mb-1">
              Impact
            </label>
            <select id="ticket-impact" value={impact} onChange={(e) => setImpact(e.target.value)} className={inputClass}>
              {TICKET_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABELS[l]}
                  {l === "low" ? " (just me)" : l === "high" ? " (whole company)" : " (a team)"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ticket-urgency" className="block text-sm font-medium mb-1">
              Urgency
            </label>
            <select id="ticket-urgency" value={urgency} onChange={(e) => setUrgency(e.target.value)} className={inputClass}>
              {TICKET_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABELS[l]}
                  {l === "low" ? " (can wait)" : l === "high" ? " (work is stopped)" : " (slowing us down)"}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="ticket-description" className="block text-sm font-medium mb-1">
            Description
          </label>
          <textarea
            id="ticket-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            rows={8}
            maxLength={50000}
            className={inputClass}
            placeholder="What happened, what you expected, and any error messages. Markdown is supported."
          />
        </div>

        {projects.length > 0 && (
          <div>
            <label htmlFor="ticket-project" className="block text-sm font-medium mb-1">
              Related project (optional)
            </label>
            <select id="ticket-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputClass}>
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="ticket-files" className="block text-sm font-medium mb-1">
            Attachments
          </label>
          <input
            id="ticket-files"
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_FILES))}
            className="text-sm"
          />
          {files.length > 0 && <p className="mt-1 text-xs text-[var(--muted-foreground)]">{files.map((f) => f.name).join(", ")}</p>}
        </div>

        <button
          type="submit"
          disabled={submitting || !subject.trim() || !description.trim()}
          className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Submitting..." : "Submit request"}
        </button>
      </form>
    </div>
  );
}
