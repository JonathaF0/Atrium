"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useCachedApi } from "@/lib/cached";
import { inputClass, labelClass } from "../contacts/shared";
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPES,
  CONTRACT_TYPE_LABELS,
  COVERAGE_PERIODS,
  COVERAGE_PERIOD_LABELS,
} from "./shared";
import type { Contract, ContractType } from "./shared";

interface Props {
  contract?: Contract;
  /** Fixes the company (company page). */
  company?: { id: string; name: string };
  onSaved: (contract: { id: string }) => void;
  onCancel: () => void;
}

function hoursInput(minutes: number | null | undefined): string {
  return minutes == null ? "" : String(Math.round((minutes / 60) * 100) / 100);
}

function moneyInput(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

export function ContractForm({ contract, company, onSaved, onCancel }: Props) {
  const companies = useCachedApi<{ data: { id: string; name: string }[] }>("/companies?limit=100")?.data ?? [];
  const slaPolicies = useCachedApi<{ id: string; name: string }[]>("/contracts/sla-policies") ?? [];
  const [companyId, setCompanyId] = useState(contract?.companyId ?? company?.id ?? "");
  const [name, setName] = useState(contract?.name ?? "");
  const [type, setType] = useState<ContractType>(contract?.type ?? "msa");
  const [status, setStatus] = useState(contract?.status ?? "active");
  const [startsAt, setStartsAt] = useState(contract?.startsAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [endsAt, setEndsAt] = useState(contract?.endsAt?.slice(0, 10) ?? "");
  const [autoRenew, setAutoRenew] = useState(contract?.autoRenew ?? false);
  const [noticeDays, setNoticeDays] = useState(String(contract?.renewalNoticeDays ?? 30));
  const [coveredHours, setCoveredHours] = useState(hoursInput(contract?.coveredMinutes));
  const [coveragePeriod, setCoveragePeriod] = useState(contract?.coveragePeriod ?? "monthly");
  const [overageRate, setOverageRate] = useState(moneyInput(contract?.overageRateCents));
  const [services, setServices] = useState((contract?.includedServices ?? []).join("\n"));
  const [slaPolicyId, setSlaPolicyId] = useState(contract?.slaPolicyId ?? "");
  const [documentUrl, setDocumentUrl] = useState(contract?.documentUrl ?? "");
  const [notes, setNotes] = useState(contract?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || !companyId || !startsAt) return;
    setSaving(true);
    setError("");
    const body: Record<string, unknown> = {
      name: name.trim(),
      type,
      status,
      startsAt: `${startsAt}T00:00:00.000Z`,
      endsAt: endsAt ? `${endsAt}T00:00:00.000Z` : null,
      autoRenew,
      renewalNoticeDays: Math.max(0, Math.min(365, Math.trunc(Number(noticeDays) || 0))),
      coveredMinutes: coveredHours.trim() === "" ? null : Math.round(Number(coveredHours) * 60),
      coveragePeriod,
      overageRateCents: overageRate.trim() === "" ? null : Math.round(Number(overageRate) * 100),
      includedServices: services
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      slaPolicyId: slaPolicyId || null,
      documentUrl: documentUrl.trim() || null,
      notes: notes.trim() || null,
    };
    if (!contract) body.companyId = companyId;
    try {
      const saved = await apiFetch<{ id: string }>(contract ? `/contracts/${contract.id}` : "/contracts", {
        method: contract ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save contract");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label={contract ? "Edit contract" : "New contract"} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="contract-name" className={labelClass}>
            Name
          </label>
          <input
            id="contract-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="contract-company" className={labelClass}>
            Company
          </label>
          {contract || company ? (
            <input id="contract-company" value={contract?.company.name ?? company?.name ?? ""} disabled className={inputClass} />
          ) : (
            <select
              id="contract-company"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              required
              className={inputClass}
            >
              <option value="">Choose a company</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label htmlFor="contract-type" className={labelClass}>
            Type
          </label>
          <select id="contract-type" value={type} onChange={(e) => setType(e.target.value as ContractType)} className={inputClass}>
            {CONTRACT_TYPES.map((t) => (
              <option key={t} value={t}>
                {CONTRACT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="contract-status" className={labelClass}>
            Status
          </label>
          <select id="contract-status" value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
            {CONTRACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CONTRACT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="contract-start" className={labelClass}>
            Starts
          </label>
          <input id="contract-start" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required className={inputClass} />
        </div>
        <div>
          <label htmlFor="contract-end" className={labelClass}>
            Ends (leave empty for open-ended)
          </label>
          <input id="contract-end" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor="contract-hours" className={labelClass}>
            Covered hours
          </label>
          <input
            id="contract-hours"
            type="number"
            min={0}
            step={0.25}
            value={coveredHours}
            onChange={(e) => setCoveredHours(e.target.value)}
            placeholder="None included"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="contract-period" className={labelClass}>
            Hours reset
          </label>
          <select id="contract-period" value={coveragePeriod} onChange={(e) => setCoveragePeriod(e.target.value)} className={inputClass}>
            {COVERAGE_PERIODS.map((p) => (
              <option key={p} value={p}>
                {COVERAGE_PERIOD_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="contract-overage" className={labelClass}>
            Overage rate per hour
          </label>
          <input
            id="contract-overage"
            type="number"
            min={0}
            step={0.01}
            value={overageRate}
            onChange={(e) => setOverageRate(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="contract-sla" className={labelClass}>
            SLA policy
          </label>
          <select id="contract-sla" value={slaPolicyId} onChange={(e) => setSlaPolicyId(e.target.value)} className={inputClass}>
            <option value="">Workspace default</option>
            {slaPolicies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="contract-notice" className={labelClass}>
            Renewal notice (days before end)
          </label>
          <input
            id="contract-notice"
            type="number"
            min={0}
            max={365}
            value={noticeDays}
            onChange={(e) => setNoticeDays(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="contract-doc" className={labelClass}>
            Document link (https)
          </label>
          <input
            id="contract-doc"
            type="url"
            pattern="https://.*"
            value={documentUrl}
            onChange={(e) => setDocumentUrl(e.target.value)}
            maxLength={2000}
            className={inputClass}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
        Renews automatically for the same term
      </label>
      <div>
        <label htmlFor="contract-services" className={labelClass}>
          Included services (one per line)
        </label>
        <textarea
          id="contract-services"
          value={services}
          onChange={(e) => setServices(e.target.value)}
          rows={4}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="contract-notes" className={labelClass}>
          Internal notes
        </label>
        <textarea
          id="contract-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={5000}
          className={inputClass}
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !name.trim() || !companyId}
          className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-40"
        >
          {saving ? "Saving..." : contract ? "Save" : "Create contract"}
        </button>
      </div>
    </form>
  );
}
