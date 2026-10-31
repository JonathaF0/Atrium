"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { useCachedApi } from "@/lib/cached";
import { inputClass, labelClass } from "../contacts/shared";
import {
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  ASSET_TYPES,
  ASSET_TYPE_LABELS,
  toDateInput,
} from "./shared";
import type { Asset, AssetType } from "./shared";

interface CompanyOption {
  id: string;
  name: string;
}

interface Props {
  asset?: Asset;
  /** Fixes the company (company page). */
  company?: CompanyOption;
  onClose: () => void;
  onSaved: () => void;
}

/** "key: value" lines to a metadata object; blank lines are ignored. */
export function parseMetadata(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i <= 0) return null;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function metadataText(meta: Asset["metadata"]): string {
  return meta ? Object.entries(meta).map(([k, v]) => `${k}: ${String(v)}`).join("\n") : "";
}

export function AssetFormModal({ asset, company, onClose, onSaved }: Props) {
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const companies = useCachedApi<{ data: CompanyOption[] }>("/companies?limit=100")?.data ?? [];
  const [companyId, setCompanyId] = useState(asset?.companyId ?? company?.id ?? "");
  const [type, setType] = useState<AssetType>(asset?.type ?? "device");
  const [name, setName] = useState(asset?.name ?? "");
  const [vendor, setVendor] = useState(asset?.vendor ?? "");
  const [model, setModel] = useState(asset?.model ?? "");
  const [serialNumber, setSerialNumber] = useState(asset?.serialNumber ?? "");
  const [assignedTo, setAssignedTo] = useState(asset?.assignedTo ?? "");
  const [status, setStatus] = useState(asset?.status ?? "active");
  const [seats, setSeats] = useState(asset?.seats == null ? "" : String(asset.seats));
  const [purchaseDate, setPurchaseDate] = useState(toDateInput(asset?.purchaseDate));
  const [warrantyEndsAt, setWarrantyEndsAt] = useState(toDateInput(asset?.warrantyEndsAt));
  const [renewsAt, setRenewsAt] = useState(toDateInput(asset?.renewsAt));
  const [clientVisible, setClientVisible] = useState(asset?.clientVisible ?? true);
  const [notes, setNotes] = useState(asset?.notes ?? "");
  const [metadata, setMetadata] = useState(metadataText(asset?.metadata ?? null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || !companyId) return;
    const meta = parseMetadata(metadata);
    if (!meta) {
      setError('Details must be one "key: value" per line');
      return;
    }
    setSaving(true);
    setError("");
    const body = {
      companyId,
      type,
      name: name.trim(),
      vendor: vendor.trim() || null,
      model: model.trim() || null,
      serialNumber: serialNumber.trim() || null,
      assignedTo: assignedTo.trim() || null,
      status,
      seats: seats.trim() === "" ? null : Math.trunc(Number(seats)),
      purchaseDate: purchaseDate || null,
      warrantyEndsAt: warrantyEndsAt || null,
      renewsAt: renewsAt || null,
      clientVisible,
      notes: notes.trim() || null,
      metadata: Object.keys(meta).length > 0 ? meta : null,
    };
    try {
      await apiFetch(asset ? `/assets/${asset.id}` : "/assets", {
        method: asset ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      success(asset ? "Asset updated" : "Asset added");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save asset");
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!asset) return;
    const ok = await confirm({
      title: "Delete asset",
      message: `Delete ${asset.name}? Its ticket links are removed too.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/assets/${asset.id}`, { method: "DELETE" });
      success("Asset deleted");
      onSaved();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete asset");
    }
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, props: Record<string, unknown> = {}) => (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input id={id} value={value} onChange={(e) => set(e.target.value)} className={inputClass} maxLength={200} {...props} />
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        aria-label={asset ? "Edit asset" : "Add asset"}
        className="bg-[var(--background)] rounded-xl shadow-lg w-full max-w-2xl mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <h3 className="text-lg font-semibold">{asset ? "Edit asset" : "Add asset"}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="asset-company" className={labelClass}>
              Company
            </label>
            {company ? (
              <input id="asset-company" value={company.name} disabled className={inputClass} />
            ) : (
              <select
                id="asset-company"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                required
                className={inputClass}
              >
                <option value="">Choose a company</option>
                {asset && !companies.some((c) => c.id === asset.companyId) && (
                  <option value={asset.companyId}>{asset.company.name}</option>
                )}
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label htmlFor="asset-type" className={labelClass}>
              Type
            </label>
            <select id="asset-type" value={type} onChange={(e) => setType(e.target.value as AssetType)} className={inputClass}>
              {ASSET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ASSET_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          {field("asset-name", "Name", name, setName, { required: true, autoFocus: true })}
          {field("asset-vendor", "Vendor", vendor, setVendor)}
          {field("asset-model", "Model / plan", model, setModel)}
          {field("asset-serial", "Serial number / key", serialNumber, setSerialNumber)}
          {field("asset-assigned", "Assigned to", assignedTo, setAssignedTo)}
          <div>
            <label htmlFor="asset-status" className={labelClass}>
              Status
            </label>
            <select id="asset-status" value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
              {ASSET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ASSET_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          {field("asset-seats", "Seats", seats, setSeats, { type: "number", min: 0, max: 1000000, step: 1 })}
          {field("asset-purchased", "Purchase date", purchaseDate, setPurchaseDate, { type: "date" })}
          {field("asset-warranty", "Warranty ends", warrantyEndsAt, setWarrantyEndsAt, { type: "date" })}
          {field("asset-renews", "Renews / expires", renewsAt, setRenewsAt, { type: "date" })}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={clientVisible} onChange={(e) => setClientVisible(e.target.checked)} />
          Visible to the client in the portal
        </label>
        <div>
          <label htmlFor="asset-details" className={labelClass}>
            Details (one &quot;key: value&quot; per line)
          </label>
          <textarea
            id="asset-details"
            value={metadata}
            onChange={(e) => setMetadata(e.target.value)}
            rows={3}
            maxLength={8000}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="asset-notes" className={labelClass}>
            Internal notes
          </label>
          <textarea
            id="asset-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={5000}
            className={inputClass}
          />
        </div>
        {asset?.externalSource && (
          <p className="text-xs text-[var(--muted-foreground)]">
            Synced from {asset.externalSource}
            {asset.externalId ? ` (${asset.externalId})` : ""}. The next sync may overwrite changes.
          </p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          <div>
            {asset && (
              <button type="button" onClick={remove} className="text-sm text-red-600 hover:underline">
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim() || !companyId}
              className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-40"
            >
              {saving ? "Saving..." : asset ? "Save" : "Add asset"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
