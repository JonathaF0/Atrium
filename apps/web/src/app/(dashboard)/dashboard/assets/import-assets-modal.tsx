"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { inputClass, labelClass } from "../contacts/shared";

const FIELD_LABELS: Record<string, string> = {
  company: "Company",
  type: "Type",
  name: "Name",
  vendor: "Vendor",
  model: "Model",
  serialNumber: "Serial number",
  assignedTo: "Assigned to",
  status: "Status",
  seats: "Seats",
  purchaseDate: "Purchase date",
  warrantyEndsAt: "Warranty ends",
  renewsAt: "Renews / expires",
  notes: "Notes",
  externalId: "External ID",
  clientVisible: "Client visible",
  skip: "Don't import",
};

interface Preview {
  headers: string[];
  rows: string[][];
  total: number;
  mapping: Record<string, string>;
}

interface Result {
  created: number;
  updated: number;
  companiesCreated: number;
  skipped: { row: number; reason: string }[];
}

export function ImportAssetsModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [createCompanies, setCreateCompanies] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function choose(f: File | null): Promise<void> {
    setFile(f);
    setPreview(null);
    setResult(null);
    setError("");
    if (!f) return;
    const form = new FormData();
    form.append("file", f);
    setBusy(true);
    try {
      const p = await apiFetch<Preview>("/assets/import/preview", { method: "POST", body: form });
      setPreview(p);
      setMapping(p.mapping);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read the file");
    } finally {
      setBusy(false);
    }
  }

  async function runImport(): Promise<void> {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("mapping", JSON.stringify(mapping));
    form.append("createCompanies", String(createCompanies));
    setBusy(true);
    setError("");
    try {
      setResult(await apiFetch<Result>("/assets/import", { method: "POST", body: form }));
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Import assets"
        className="bg-[var(--background)] rounded-xl shadow-lg w-full max-w-2xl mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <h3 className="text-lg font-semibold">Import assets from CSV</h3>
        <p className="text-sm text-[var(--muted-foreground)]">
          One asset per row. Rows whose external ID or serial number matches an existing asset update it.
          Dates as YYYY-MM-DD.
        </p>
        <div>
          <label htmlFor="asset-import-file" className={labelClass}>
            CSV file
          </label>
          <input
            id="asset-import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
        </div>
        {preview && !result && (
          <>
            <p className="text-sm">{preview.total} row(s). Match the columns:</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {preview.headers.map((h) => (
                <div key={h} className="flex items-center gap-2">
                  <span className="text-sm w-1/2 truncate" title={h}>
                    {h}
                  </span>
                  <select
                    aria-label={`Field for ${h}`}
                    value={mapping[h] ?? "skip"}
                    onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}
                    className={inputClass}
                  >
                    {Object.entries(FIELD_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={createCompanies} onChange={(e) => setCreateCompanies(e.target.checked)} />
              Create companies that don&apos;t exist yet
            </label>
          </>
        )}
        {result && (
          <div className="text-sm space-y-1" data-testid="asset-import-result">
            <p>
              {result.created} created, {result.updated} updated
              {result.companiesCreated > 0 ? `, ${result.companiesCreated} companies added` : ""}.
            </p>
            {result.skipped.length > 0 && (
              <ul className="text-[var(--muted-foreground)] list-disc pl-5">
                {result.skipped.slice(0, 20).map((s) => (
                  <li key={s.row}>
                    Row {s.row}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]"
          >
            {result ? "Done" : "Cancel"}
          </button>
          {!result && (
            <button
              type="button"
              onClick={runImport}
              disabled={busy || !preview}
              className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "Working..." : "Import"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
