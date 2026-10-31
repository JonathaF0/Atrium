"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Paperclip } from "lucide-react";
import { CLIENT_DOC_SECTIONS, CLIENT_DOC_SECTION_LABELS } from "@atrium/shared";
import type { ClientDocSection } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { formatDate } from "@/lib/kb";

const API_URL: string = process.env.NEXT_PUBLIC_API_URL || "";

interface ClientDoc {
  id: string;
  section: ClientDocSection;
  title: string;
  body: string;
  vaultUrl: string | null;
  updatedAt: string;
  attachments: { id: string; filename: string }[];
}

/** Environment documentation the IT team keeps for the user's company. */
export default function PortalDocsPage() {
  const [docs, setDocs] = useState<ClientDoc[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiFetch<ClientDoc[]>("/client-docs/mine")
      .then(setDocs)
      .catch(() => setFailed(true));
  }, []);

  const sections = CLIENT_DOC_SECTIONS.map((section) => ({
    section,
    docs: (docs ?? []).filter((d) => d.section === section),
  })).filter((s) => s.docs.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Documentation</h1>
        <p className="text-sm text-[var(--muted-foreground)]">
          How your environment is set up. Passwords are never kept here; use the vault links.
        </p>
      </div>
      {failed ? (
        <p className="text-sm text-[var(--muted-foreground)]">Couldn&apos;t load documentation.</p>
      ) : docs === null ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
      ) : docs.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)] py-8 text-center">No documentation has been shared with you yet.</p>
      ) : (
        sections.map(({ section, docs: list }) => (
          <section key={section} className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              {CLIENT_DOC_SECTION_LABELS[section]}
            </h2>
            {list.map((doc) => (
              <details key={doc.id} className="border border-[var(--border)] rounded-xl group" open={docs.length <= 3}>
                <summary className="cursor-pointer px-4 py-3 flex items-center gap-2">
                  <span className="font-medium flex-1">{doc.title}</span>
                  <span className="text-xs text-[var(--muted-foreground)]">Updated {formatDate(doc.updatedAt)}</span>
                </summary>
                <div className="px-4 pb-4 space-y-3">
                  {doc.body ? <Markdown source={doc.body} /> : null}
                  {doc.vaultUrl && (
                    <a
                      href={doc.vaultUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 text-sm text-[var(--primary)] hover:underline"
                    >
                      Open in password vault <ExternalLink size={13} />
                    </a>
                  )}
                  {doc.attachments.length > 0 && (
                    <ul className="space-y-1">
                      {doc.attachments.map((att) => (
                        <li key={att.id}>
                          <a
                            href={`${API_URL}/api/client-docs/mine/attachments/${att.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 text-sm hover:underline"
                          >
                            <Paperclip size={13} /> {att.filename}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
