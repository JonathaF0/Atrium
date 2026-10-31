"use client";

import { useRef, useState } from "react";
import { Bold, Code, Heading2, ImagePlus, Italic, Link2, List, Loader2 } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { kbBodyForDisplay } from "@/lib/kb";

type Wrap = { before: string; after: string; placeholder: string; line?: boolean };

const ACTIONS: Array<{ label: string; icon: React.ReactNode; wrap: Wrap }> = [
  { label: "Bold", icon: <Bold size={15} />, wrap: { before: "**", after: "**", placeholder: "bold text" } },
  { label: "Italic", icon: <Italic size={15} />, wrap: { before: "_", after: "_", placeholder: "italic text" } },
  { label: "Heading", icon: <Heading2 size={15} />, wrap: { before: "## ", after: "", placeholder: "Heading", line: true } },
  { label: "List", icon: <List size={15} />, wrap: { before: "- ", after: "", placeholder: "List item", line: true } },
  { label: "Link", icon: <Link2 size={15} />, wrap: { before: "[", after: "](https://)", placeholder: "link text" } },
  { label: "Code", icon: <Code size={15} />, wrap: { before: "`", after: "`", placeholder: "code" } },
];

/**
 * Markdown textarea with a small formatting toolbar and a live preview that
 * uses the same renderer readers see.
 */
export function MarkdownEditor({
  value,
  onChange,
  onUpload,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Uploads a file and returns the markdown to insert, or null on failure. */
  onUpload: (file: File) => Promise<string | null>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<"write" | "preview">("write");
  const [uploading, setUploading] = useState(false);

  function insert(text: string, selectFrom?: number, selectTo?: number): void {
    const el = ref.current;
    const start: number = el?.selectionStart ?? value.length;
    const end: number = el?.selectionEnd ?? value.length;
    const next: string = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + (selectFrom ?? text.length), start + (selectTo ?? text.length));
    });
  }

  function apply(wrap: Wrap): void {
    const el = ref.current;
    const start: number = el?.selectionStart ?? value.length;
    const end: number = el?.selectionEnd ?? value.length;
    const selected: string = value.slice(start, end) || wrap.placeholder;
    const lineStart: boolean = start === 0 || value[start - 1] === "\n";
    const prefix: string = wrap.line && !lineStart ? "\n" : "";
    const text = `${prefix}${wrap.before}${selected}${wrap.after}`;
    const from: number = prefix.length + wrap.before.length;
    insert(text, from, from + selected.length);
  }

  async function upload(file: File): Promise<void> {
    setUploading(true);
    try {
      const md: string | null = await onUpload(file);
      if (md) insert(`${md}\n`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const tabClass = (active: boolean): string =>
    `px-2 py-1 text-xs rounded ${active ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`;

  return (
    <div className="border border-[var(--border)] rounded-xl overflow-hidden">
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1.5 flex-wrap" role="toolbar" aria-label="Formatting">
        {ACTIONS.map((a) => (
          <button
            key={a.label}
            type="button"
            title={a.label}
            aria-label={a.label}
            onClick={() => apply(a.wrap)}
            disabled={view === "preview"}
            className="p-1.5 rounded hover:bg-[var(--muted)] disabled:opacity-40"
          >
            {a.icon}
          </button>
        ))}
        <button
          type="button"
          title="Upload image or file"
          aria-label="Upload image or file"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || view === "preview"}
          className="p-1.5 rounded hover:bg-[var(--muted)] disabled:opacity-40"
        >
          {uploading ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
        </button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
          }}
        />
        <div className="ml-auto flex gap-1 lg:hidden">
          <button type="button" className={tabClass(view === "write")} onClick={() => setView("write")}>
            Write
          </button>
          <button type="button" className={tabClass(view === "preview")} onClick={() => setView("preview")}>
            Preview
          </button>
        </div>
      </div>
      <div className="grid lg:grid-cols-2 lg:divide-x divide-[var(--border)]">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Article body (markdown)"
          maxLength={100000}
          placeholder="Write the article in markdown..."
          className={`${view === "preview" ? "hidden lg:block" : ""} w-full min-h-[28rem] p-4 bg-[var(--background)] text-sm font-mono outline-none resize-y`}
        />
        <div className={`${view === "write" ? "hidden lg:block" : ""} p-4 min-h-[28rem] overflow-auto`} data-testid="kb-preview">
          {value.trim() ? (
            <Markdown source={kbBodyForDisplay(value)} />
          ) : (
            <p className="text-sm text-[var(--muted-foreground)]">Nothing to preview yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
