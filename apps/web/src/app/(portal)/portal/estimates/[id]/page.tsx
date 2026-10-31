"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Check, Download, MessageSquare, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useCurrency } from "@/lib/app-config";
import { downloadCsv } from "@/lib/download";
import { useToast } from "@/components/toast";
import { SignaturePad } from "@/components/signature-pad";
import { EstimateDocument, type EstimateDocData, type EstimateDocLine } from "@/components/estimate-document";
import { EstimateStatusBadge } from "@/components/estimate-status-badge";

interface PortalEstimate extends EstimateDocData {
  id: string;
  number: string;
  version: number;
  status: string;
  acceptedName: string | null;
  declineReason: string | null;
  canRespond: boolean;
  comments: Array<{ id: string; content: string; createdAt: string; authorName: string | null; mine: boolean }>;
}

type Panel = "accept" | "changes" | "decline" | null;

/** Scales the pad's PNG down to at most 600px wide so the upload stays small. */
async function shrinkSignature(dataUrl: string): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not read the signature"));
    img.src = dataUrl;
  });
  const scale = Math.min(1, 600 / img.width);
  if (scale >= 1) return dataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

const inputClass =
  "w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm outline-none focus:ring-1 focus:ring-[var(--primary)]";

export default function PortalEstimatePage() {
  const { id } = useParams<{ id: string }>();
  const currency = useCurrency();
  const { success, error: showError } = useToast();
  const [estimate, setEstimate] = useState<PortalEstimate | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullName, setFullName] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [signatureMethod, setSignatureMethod] = useState<"draw" | "type">("type");
  const [agree, setAgree] = useState(false);
  const [message, setMessage] = useState("");
  const [comment, setComment] = useState("");

  const load = useCallback(async () => {
    try {
      setEstimate(await apiFetch<PortalEstimate>(`/estimates/mine/${id}`));
    } catch {
      setNotFound(true);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function post(path: string, body: unknown, done: string): Promise<boolean> {
    setBusy(true);
    try {
      setEstimate(await apiFetch<PortalEstimate>(`/estimates/mine/${id}/${path}`, { method: "POST", body: JSON.stringify(body) }));
      success(done);
      return true;
    } catch (err) {
      showError(err instanceof Error ? err.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function toggle(line: EstimateDocLine, selected: boolean): Promise<void> {
    if (!line.id) return;
    setToggling(line.id);
    try {
      setEstimate(
        await apiFetch<PortalEstimate>(`/estimates/mine/${id}/options`, {
          method: "POST",
          body: JSON.stringify({ lineItemId: line.id, selected }),
        }),
      );
    } catch (err) {
      showError(err instanceof Error ? err.message : "Could not update the option");
    } finally {
      setToggling(null);
    }
  }

  if (notFound) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-[var(--muted-foreground)]">Estimate not found.</p>
        <Link href="/portal/estimates" className="text-sm text-[var(--primary)] hover:underline">Back to estimates</Link>
      </div>
    );
  }
  if (!estimate) return <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>;

  const e = estimate;
  const drawn = signature !== null && signatureMethod === "draw";
  const canAccept = fullName.trim().length >= 2 && drawn && agree && !busy;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/portal/estimates" className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
          <ArrowLeft size={14} /> Estimates
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">
              {e.number}
              {e.version > 1 && <span className="text-[var(--muted-foreground)] font-normal"> v{e.version}</span>}
            </h1>
            <EstimateStatusBadge status={e.status} />
          </div>
          <button
            onClick={() => downloadCsv(`/estimates/mine/${id}/pdf`).catch(() => showError("Download failed"))}
            className="flex items-center gap-1.5 px-3 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]"
          >
            <Download size={14} /> PDF
          </button>
        </div>
      </div>

      {e.status === "accepted" || e.status === "converted" ? (
        <div className="p-3 rounded-lg bg-emerald-500/10 text-sm">You accepted this estimate{e.acceptedName ? ` as ${e.acceptedName}` : ""}. Thank you.</div>
      ) : e.status === "declined" ? (
        <div className="p-3 rounded-lg bg-rose-500/10 text-sm">You declined this estimate.</div>
      ) : e.status === "expired" ? (
        <div className="p-3 rounded-lg bg-[var(--muted)] text-sm">This estimate has expired. Contact us for an updated one.</div>
      ) : e.status === "changes_requested" ? (
        <div className="p-3 rounded-lg bg-amber-500/10 text-sm">You asked for changes. We&apos;ll send an updated estimate.</div>
      ) : null}

      <div className="border border-[var(--border)] rounded-xl p-5">
        <EstimateDocument estimate={e} currency={currency} onToggle={e.canRespond ? toggle : undefined} toggling={toggling} />
      </div>

      {e.canRespond && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setPanel(panel === "accept" ? null : "accept")}
              className="flex items-center gap-1.5 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium"
            >
              <Check size={14} /> Accept
            </button>
            <button
              onClick={() => setPanel(panel === "changes" ? null : "changes")}
              className="flex items-center gap-1.5 px-4 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]"
            >
              <MessageSquare size={14} /> Request changes
            </button>
            <button
              onClick={() => setPanel(panel === "decline" ? null : "decline")}
              className="flex items-center gap-1.5 px-4 py-2 border border-[var(--border)] rounded-lg text-sm text-red-600 hover:bg-[var(--muted)]"
            >
              <X size={14} /> Decline
            </button>
          </div>

          {panel === "accept" && (
            <div className="border border-[var(--border)] rounded-xl p-4 space-y-3" data-testid="accept-panel">
              <h2 className="font-semibold">Accept and sign</h2>
              <label className="block text-sm">
                <span className="text-[var(--muted-foreground)]">Your full name</span>
                <input aria-label="Full name" value={fullName} maxLength={200} onChange={(ev) => setFullName(ev.target.value)} className={inputClass} />
              </label>
              <div>
                <p className="text-sm text-[var(--muted-foreground)] mb-1">Draw your signature (choose Draw)</p>
                <SignaturePad
                  onSignatureChange={(dataUrl, method) => {
                    setSignature(dataUrl);
                    setSignatureMethod(method);
                  }}
                />
                {signature && signatureMethod !== "draw" && (
                  <p className="text-xs text-amber-600 mt-1">Please draw your signature; a typed signature isn&apos;t accepted here.</p>
                )}
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={agree} onChange={(ev) => setAgree(ev.target.checked)} />
                I accept this estimate, including the selected options, terms and total, and agree that this counts as my signature.
              </label>
              <button
                disabled={!canAccept}
                onClick={async () => {
                  const ok = await post(
                    "accept",
                    { fullName: fullName.trim(), signature: await shrinkSignature(signature!), agree },
                    "Estimate accepted",
                  );
                  if (ok) setPanel(null);
                }}
                className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {busy ? "Submitting..." : "Accept estimate"}
              </button>
            </div>
          )}

          {(panel === "changes" || panel === "decline") && (
            <div className="border border-[var(--border)] rounded-xl p-4 space-y-3">
              <h2 className="font-semibold">{panel === "changes" ? "What should we change?" : "Decline the estimate"}</h2>
              <textarea
                aria-label={panel === "changes" ? "Requested changes" : "Reason for declining"}
                rows={4}
                maxLength={panel === "changes" ? 5000 : 2000}
                value={message}
                onChange={(ev) => setMessage(ev.target.value)}
                placeholder={panel === "changes" ? "Describe the changes you need..." : "Optional: tell us why"}
                className={inputClass}
              />
              <button
                disabled={busy || (panel === "changes" && !message.trim())}
                onClick={async () => {
                  const ok =
                    panel === "changes"
                      ? await post("request-changes", { content: message.trim() }, "Change request sent")
                      : await post("decline", { reason: message.trim() || undefined }, "Estimate declined");
                  if (ok) {
                    setMessage("");
                    setPanel(null);
                  }
                }}
                className={`px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 ${panel === "changes" ? "bg-[var(--primary)] text-white" : "bg-red-600 text-white"}`}
              >
                {panel === "changes" ? "Send request" : "Decline estimate"}
              </button>
            </div>
          )}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Questions and comments</h2>
        <ul className="space-y-2" data-testid="portal-estimate-comments">
          {e.comments.length === 0 && <li className="text-sm text-[var(--muted-foreground)]">No comments yet.</li>}
          {e.comments.map((c) => (
            <li key={c.id} className={`border border-[var(--border)] rounded-lg p-3 text-sm ${c.mine ? "bg-[var(--muted)]/40" : ""}`}>
              <p className="text-xs text-[var(--muted-foreground)] mb-1">
                {c.mine ? "You" : (c.authorName ?? "Team")} · {new Date(c.createdAt).toLocaleString()}
              </p>
              <p className="whitespace-pre-wrap">{c.content}</p>
            </li>
          ))}
        </ul>
        <form
          onSubmit={async (ev) => {
            ev.preventDefault();
            if (!comment.trim()) return;
            if (await post("comments", { content: comment.trim() }, "Comment sent")) setComment("");
          }}
          className="flex gap-2"
        >
          <input
            aria-label="Comment"
            value={comment}
            maxLength={5000}
            onChange={(ev) => setComment(ev.target.value)}
            placeholder="Ask a question..."
            className="flex-1 px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
          />
          <button type="submit" disabled={!comment.trim() || busy} className="px-3 py-2 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-40">
            Send
          </button>
        </form>
      </section>
    </div>
  );
}
