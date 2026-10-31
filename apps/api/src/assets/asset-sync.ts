import type { AssetType } from "@atrium/shared";
import { metadataError, parseDateInput } from "./asset-fields";
import type { AssetMetadata, AssetStatus } from "./asset-fields";

export const MAX_SYNC_BATCH = 500;
export const SYNC_SOURCE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,49}$/;

/**
 * One record pushed by an RMM/PSA connector to `PUT /assets/sync/:source`.
 * Fields left out are kept as they are on update; `null` clears them.
 */
export interface SyncAssetInput {
  externalId: string;
  companyId?: string;
  companyName?: string;
  type: AssetType;
  name: string;
  vendor?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  assignedTo?: string | null;
  status?: AssetStatus;
  seats?: number | null;
  purchaseDate?: string | null;
  warrantyEndsAt?: string | null;
  renewsAt?: string | null;
  notes?: string | null;
  clientVisible?: boolean;
  metadata?: AssetMetadata | null;
}

export interface ExistingSyncedAsset {
  id: string;
  externalId: string;
  status: string;
}

export interface SyncCompany {
  id: string;
  name: string;
}

export type AssetWriteData = {
  companyId: string;
  type: AssetType;
  name: string;
  vendor?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  assignedTo?: string | null;
  status?: AssetStatus;
  seats?: number | null;
  purchaseDate?: Date | null;
  warrantyEndsAt?: Date | null;
  renewsAt?: Date | null;
  notes?: string | null;
  clientVisible?: boolean;
  metadata?: AssetMetadata | null;
};

export interface SyncError {
  index: number;
  externalId: string;
  reason: string;
}

export interface SyncPlan {
  creates: Array<{ externalId: string; data: AssetWriteData }>;
  updates: Array<{ id: string; externalId: string; data: AssetWriteData }>;
  errors: SyncError[];
  /** Every externalId named in the batch, valid or not: a full sync never retires these. */
  keepExternalIds: string[];
}

function optionalDate(value: string | null | undefined): Date | null | undefined | "invalid" {
  if (value === undefined || value === null) return value;
  return parseDateInput(value) ?? "invalid";
}

/**
 * Turns a connector batch into creates and updates. Companies are matched by id
 * (must be in the workspace: `companies` holds only its companies) or by name,
 * case-insensitively. A record that was retired and shows up again is reactivated
 * unless the batch says otherwise.
 */
export function planSync(
  items: SyncAssetInput[],
  existing: ExistingSyncedAsset[],
  companies: SyncCompany[],
): SyncPlan {
  const byId = new Map(companies.map((c) => [c.id, c]));
  const byName = new Map(companies.map((c) => [c.name.trim().toLowerCase(), c]));
  const existingByExt = new Map(existing.map((a) => [a.externalId, a]));
  const seen = new Set<string>();
  const plan: SyncPlan = { creates: [], updates: [], errors: [], keepExternalIds: [] };

  items.forEach((item, index) => {
    const externalId = item.externalId;
    plan.keepExternalIds.push(externalId);
    const fail = (reason: string): void => {
      plan.errors.push({ index, externalId, reason });
    };
    if (seen.has(externalId)) return fail("Duplicate externalId in this batch");
    seen.add(externalId);

    const company = item.companyId
      ? byId.get(item.companyId)
      : item.companyName
        ? byName.get(item.companyName.trim().toLowerCase())
        : undefined;
    if (!item.companyId && !item.companyName) return fail("companyId or companyName is required");
    if (!company) return fail("Unknown company");

    const metaErr = metadataError(item.metadata);
    if (metaErr) return fail(metaErr);

    const purchaseDate = optionalDate(item.purchaseDate);
    const warrantyEndsAt = optionalDate(item.warrantyEndsAt);
    const renewsAt = optionalDate(item.renewsAt);
    if (purchaseDate === "invalid" || warrantyEndsAt === "invalid" || renewsAt === "invalid") {
      return fail("Dates must be YYYY-MM-DD or ISO 8601");
    }

    const data: AssetWriteData = {
      companyId: company.id,
      type: item.type,
      name: item.name.trim(),
      vendor: item.vendor,
      model: item.model,
      serialNumber: item.serialNumber,
      assignedTo: item.assignedTo,
      status: item.status,
      seats: item.seats,
      purchaseDate,
      warrantyEndsAt,
      renewsAt,
      notes: item.notes,
      clientVisible: item.clientVisible,
      metadata: item.metadata,
    };
    if (!data.name) return fail("name is required");

    const current = existingByExt.get(externalId);
    if (current) {
      if (data.status === undefined && current.status === "retired") data.status = "active";
      plan.updates.push({ id: current.id, externalId, data });
    } else {
      plan.creates.push({ externalId, data: { ...data, status: data.status ?? "active" } });
    }
  });

  return plan;
}
