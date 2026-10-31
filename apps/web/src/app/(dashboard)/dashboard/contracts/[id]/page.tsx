"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { formatDuration } from "@/lib/format-duration";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { ProjectDetailSkeleton } from "@/components/skeletons";
import { ContractForm } from "../contract-form";
import { UsageBar } from "../usage-bar";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  COVERAGE_PERIOD_LABELS,
  formatDay,
  formatMinutes,
} from "../shared";
import type { Contract } from "../shared";

interface TimeEntryRow {
  id: string;
  description: string | null;
  startedAt: string;
  durationSec: number | null;
  billable: boolean;
  project: { id: string; name: string };
  user: { id: string; name: string };
}

const headingClass = "text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)] mb-2";
const buttonClass = "px-3 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)] transition-colors";

function EntryList({
  entries,
  action,
  onAction,
  empty,
}: {
  entries: TimeEntryRow[];
  action: string;
  onAction: (id: string) => void;
  empty: string;
}) {
  if (entries.length === 0) return <p className="text-sm text-[var(--muted-foreground)]">{empty}</p>;
  return (
    <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl">
      {entries.map((e) => (
        <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate">{e.description || "No description"}</p>
            <p className="text-xs text-[var(--muted-foreground)]">
              {formatDay(e.startedAt)} · {e.project.name} · {e.user.name}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="tabular-nums">{formatDuration(e.durationSec ?? 0)}</span>
            <button type="button" onClick={() => onAction(e.id)} className="text-xs hover:underline">
              {action}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [contract, setContract] = useState<Contract | null>(null);
  const [attached, setAttached] = useState<TimeEntryRow[]>([]);
  const [attachable, setAttachable] = useState<TimeEntryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [c, a, b] = await Promise.all([
        apiFetch<Contract>(`/contracts/${id}`),
        apiFetch<TimeEntryRow[]>(`/contracts/${id}/time-entries`),
        apiFetch<TimeEntryRow[]>(`/contracts/${id}/time-entries/attachable`),
      ]);
      setContract(c);
      setAttached(a);
      setAttachable(b);
    } catch (err) {
      console.error(err);
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function setEntry(entryId: string, attach: boolean): Promise<void> {
    try {
      await apiFetch(`/contracts/${id}/time-entries/${entryId}`, { method: attach ? "POST" : "DELETE" });
      success(attach ? "Time counted against the contract" : "Time taken off the contract");
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to update the time entry");
    }
  }

  async function remove(): Promise<void> {
    if (!contract) return;
    const ok = await confirm({
      title: "Delete contract",
      message: `Delete ${contract.name}? Time counted against it becomes unassigned.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/contracts/${contract.id}`, { method: "DELETE" });
      router.push("/dashboard/contracts");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete contract");
    }
  }

  if (loading) return <ProjectDetailSkeleton />;
  if (notFound || !contract) {
    return (
      <div className="py-12 text-center space-y-2">
        <p className="text-[var(--muted-foreground)]">Contract not found.</p>
        <Link href="/dashboard/contracts" className="text-sm hover:underline">
          Back to contracts
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/dashboard/contracts" className="text-sm text-[var(--muted-foreground)] hover:underline">
        ‹ Contracts
      </Link>
      {editing ? (
        <ContractForm
          contract={contract}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            success("Contract updated");
            setEditing(false);
            load();
          }}
        />
      ) : (
        <>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold">{contract.name}</h1>
              <p className="text-sm text-[var(--muted-foreground)]">
                <Link href={`/dashboard/contacts/companies/${contract.company.id}`} className="hover:underline">
                  {contract.company.name}
                </Link>{" "}
                · {CONTRACT_TYPE_LABELS[contract.type] ?? contract.type} · {CONTRACT_STATUS_LABELS[contract.status] ?? contract.status}
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditing(true)} className={buttonClass}>
                Edit
              </button>
              <button onClick={remove} className={`${buttonClass} text-red-600`}>
                Delete
              </button>
            </div>
          </div>

          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
            <div>
              <dt className="text-[var(--muted-foreground)]">Term</dt>
              <dd>
                {formatDay(contract.startsAt)} – {contract.endsAt ? formatDay(contract.endsAt) : "open-ended"}
                {contract.autoRenew && " (auto-renews)"}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--muted-foreground)]">Covered hours</dt>
              <dd>
                {contract.coveredMinutes == null
                  ? "None included"
                  : `${formatMinutes(contract.coveredMinutes)} ${COVERAGE_PERIOD_LABELS[contract.coveragePeriod] ?? ""}`}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--muted-foreground)]">Overage rate</dt>
              <dd>{contract.overageRateCents == null ? "-" : `${formatCurrency(contract.overageRateCents)} / hour`}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted-foreground)]">SLA policy</dt>
              <dd>{contract.slaPolicy?.name ?? "Workspace default"}</dd>
            </div>
          </dl>

          {contract.usage && contract.usage.coveredMinutes != null && (
            <section className="max-w-xl">
              <h2 className={headingClass}>This period</h2>
              <UsageBar usage={contract.usage} />
              {contract.usage.overageCents != null && contract.usage.overageCents > 0 && (
                <p className="text-sm text-red-600 mt-1">Overage: {formatCurrency(contract.usage.overageCents)}</p>
              )}
            </section>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            <section>
              <h2 className={headingClass}>Included services</h2>
              {contract.includedServices.length === 0 ? (
                <p className="text-sm text-[var(--muted-foreground)]">None listed.</p>
              ) : (
                <ul className="list-disc pl-5 text-sm space-y-1">
                  {contract.includedServices.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
              {contract.documentUrl && (
                <a
                  href={contract.documentUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-block mt-3 text-sm hover:underline"
                >
                  Open contract document
                </a>
              )}
            </section>
            <section>
              <h2 className={headingClass}>Notes</h2>
              <p className="text-sm whitespace-pre-wrap">{contract.notes || "-"}</p>
            </section>
          </div>

          <section>
            <h2 className={headingClass}>Time counted this period</h2>
            <EntryList
              entries={attached}
              action="Remove"
              onAction={(entryId) => setEntry(entryId, false)}
              empty="No time counted against this contract this period."
            />
          </section>
          <section>
            <h2 className={headingClass}>Recent time for {contract.company.name}</h2>
            <EntryList
              entries={attachable}
              action="Count against contract"
              onAction={(entryId) => setEntry(entryId, true)}
              empty="No uncounted time from this company's projects or tickets."
            />
          </section>
        </>
      )}
    </div>
  );
}
