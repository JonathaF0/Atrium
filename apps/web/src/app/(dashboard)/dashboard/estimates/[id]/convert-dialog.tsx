"use client";

import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useCurrency } from "@/lib/app-config";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/components/toast";

interface ConvertTarget {
  id: string;
  title: string;
  depositPercent: number | null;
  project: { id: string; name: string } | null;
  totals: { totalCents: number; recurringSubtotalCents: number };
}

const radio = "flex items-start gap-2 text-sm cursor-pointer";

export function ConvertDialog({ estimate, onClose, onDone }: { estimate: ConvertTarget; onClose: () => void; onDone: () => void }) {
  const currency = useCurrency();
  const { success, error: showError } = useToast();
  const [project, setProject] = useState<"create" | "existing">(estimate.project ? "existing" : "create");
  const [projectName, setProjectName] = useState(estimate.title);
  const [mode, setMode] = useState<"full" | "deposit" | "milestones">(estimate.depositPercent ? "deposit" : "full");
  const [deposit, setDeposit] = useState(String(estimate.depositPercent || 50));
  const [milestones, setMilestones] = useState<Array<{ label: string; percent: string }>>([
    { label: "Kickoff", percent: "50" },
    { label: "Completion", percent: "50" },
  ]);
  const [saving, setSaving] = useState(false);

  const milestoneSum = milestones.reduce((s, m) => s + (parseInt(m.percent, 10) || 0), 0);
  const depositPct = parseInt(deposit, 10) || 0;
  const valid =
    (project === "create" ? projectName.trim().length > 0 : true) &&
    (mode !== "deposit" || (depositPct >= 1 && depositPct <= 99)) &&
    (mode !== "milestones" || (milestoneSum === 100 && milestones.length >= 2));

  async function submit(): Promise<void> {
    setSaving(true);
    try {
      await apiFetch(`/estimates/${estimate.id}/convert`, {
        method: "POST",
        body: JSON.stringify({
          project,
          projectId: project === "existing" ? estimate.project?.id : undefined,
          projectName: project === "create" ? projectName.trim() : undefined,
          invoices: mode,
          depositPercent: mode === "deposit" ? depositPct : undefined,
          milestones:
            mode === "milestones"
              ? milestones.map((m) => ({ label: m.label.trim() || undefined, percent: parseInt(m.percent, 10) || 0 }))
              : undefined,
        }),
      });
      success("Estimate converted. Draft invoices are ready for review.");
      onDone();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Conversion failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Convert estimate">
      <div className="w-full max-w-lg bg-[var(--background)] border border-[var(--border)] rounded-xl p-5 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Convert estimate</h2>
          <button onClick={onClose} aria-label="Close" className="text-[var(--muted-foreground)]"><X size={18} /></button>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Project</legend>
          <label className={radio}>
            <input type="radio" name="project" checked={project === "create"} onChange={() => setProject("create")} />
            <span className="flex-1">
              Create a new project
              {project === "create" && (
                <input
                  aria-label="Project name"
                  value={projectName}
                  maxLength={200}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="mt-1 w-full px-3 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
                />
              )}
            </span>
          </label>
          {estimate.project && (
            <label className={radio}>
              <input type="radio" name="project" checked={project === "existing"} onChange={() => setProject("existing")} />
              Use the linked project: {estimate.project.name}
            </label>
          )}
          <p className="text-xs text-[var(--muted-foreground)]">The recipient is added to the project as a client.</p>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium mb-1">Invoices (created as drafts)</legend>
          <label className={radio}>
            <input type="radio" name="mode" checked={mode === "full"} onChange={() => setMode("full")} />
            One invoice for the full amount ({formatCurrency(estimate.totals.totalCents, currency)})
          </label>
          <label className={radio}>
            <input type="radio" name="mode" checked={mode === "deposit"} onChange={() => setMode("deposit")} />
            <span>
              Deposit now and the balance later
              {mode === "deposit" && (
                <span className="flex items-center gap-2 mt-1">
                  <input
                    aria-label="Deposit percent"
                    inputMode="numeric"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value.replace(/\D/g, ""))}
                    className="w-16 px-2 py-1 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
                  />
                  % deposit ({formatCurrency(Math.round((estimate.totals.totalCents * depositPct) / 100), currency)})
                </span>
              )}
            </span>
          </label>
          <label className={radio}>
            <input type="radio" name="mode" checked={mode === "milestones"} onChange={() => setMode("milestones")} />
            Milestones
          </label>
          {mode === "milestones" && (
            <div className="ml-6 space-y-2">
              {milestones.map((m, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    aria-label={`Milestone ${i + 1} name`}
                    value={m.label}
                    maxLength={100}
                    onChange={(e) => setMilestones((p) => p.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    className="flex-1 px-2 py-1 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
                  />
                  <input
                    aria-label={`Milestone ${i + 1} percent`}
                    inputMode="numeric"
                    value={m.percent}
                    onChange={(e) => setMilestones((p) => p.map((x, j) => (j === i ? { ...x, percent: e.target.value.replace(/\D/g, "") } : x)))}
                    className="w-16 px-2 py-1 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
                  />
                  %
                  {milestones.length > 2 && (
                    <button type="button" aria-label="Remove milestone" onClick={() => setMilestones((p) => p.filter((_, j) => j !== i))} className="text-[var(--muted-foreground)]">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  disabled={milestones.length >= 12}
                  onClick={() => setMilestones((p) => [...p, { label: "", percent: "0" }])}
                  className="flex items-center gap-1 text-[var(--primary)]"
                >
                  <Plus size={12} /> Add milestone
                </button>
                <span className={milestoneSum === 100 ? "text-[var(--muted-foreground)]" : "text-red-600"}>Total {milestoneSum}%</span>
              </div>
            </div>
          )}
          {estimate.totals.recurringSubtotalCents > 0 && (
            <p className="text-xs text-[var(--muted-foreground)]">
              Recurring items become a paused recurring invoice schedule. Review and activate it when the service starts.
            </p>
          )}
        </fieldset>

        <p className="text-xs text-[var(--muted-foreground)]">The signed estimate is stored in the project&apos;s documents.</p>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm">Cancel</button>
          <button onClick={submit} disabled={!valid || saving} className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {saving ? "Converting..." : "Convert"}
          </button>
        </div>
      </div>
    </div>
  );
}
