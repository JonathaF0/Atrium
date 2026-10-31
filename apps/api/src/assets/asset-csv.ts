import type { AssetType } from "@atrium/shared";
import { toCsv } from "../common";
import type { CsvColumn } from "../common";
import {
  ASSET_EXTERNAL_ID_MAX,
  ASSET_NAME_MAX,
  ASSET_NOTES_MAX,
  ASSET_SEATS_MAX,
  ASSET_TEXT_MAX,
  parseAssetStatus,
  parseAssetType,
  parseDateInput,
} from "./asset-fields";
import type { AssetStatus } from "./asset-fields";

export const ASSET_IMPORT_FIELDS = [
  "company",
  "type",
  "name",
  "vendor",
  "model",
  "serialNumber",
  "assignedTo",
  "status",
  "seats",
  "purchaseDate",
  "warrantyEndsAt",
  "renewsAt",
  "notes",
  "externalId",
  "clientVisible",
  "skip",
] as const;
export type AssetImportField = (typeof ASSET_IMPORT_FIELDS)[number];
export type AssetImportMapping = Record<string, AssetImportField>;

export const MAX_ASSET_IMPORT_ROWS = 2000;

/** Header spellings recognised without a mapping (lowercased, spaces/underscores removed). */
const HEADER_ALIASES: Record<string, AssetImportField> = {
  company: "company",
  companyname: "company",
  client: "company",
  customer: "company",
  organization: "company",
  type: "type",
  assettype: "type",
  name: "name",
  assetname: "name",
  hostname: "name",
  devicename: "name",
  vendor: "vendor",
  manufacturer: "vendor",
  make: "vendor",
  model: "model",
  serial: "serialNumber",
  serialnumber: "serialNumber",
  serialno: "serialNumber",
  assignedto: "assignedTo",
  user: "assignedTo",
  location: "assignedTo",
  status: "status",
  seats: "seats",
  licenses: "seats",
  quantity: "seats",
  purchasedate: "purchaseDate",
  purchased: "purchaseDate",
  warrantyendsat: "warrantyEndsAt",
  warrantyend: "warrantyEndsAt",
  warrantyexpiry: "warrantyEndsAt",
  warranty: "warrantyEndsAt",
  renewsat: "renewsAt",
  renewaldate: "renewsAt",
  renews: "renewsAt",
  expires: "renewsAt",
  expiry: "renewsAt",
  expirydate: "renewsAt",
  expirationdate: "renewsAt",
  notes: "notes",
  externalid: "externalId",
  id: "externalId",
  clientvisible: "clientVisible",
  visibletoclient: "clientVisible",
};

export function suggestMapping(headers: string[]): AssetImportMapping {
  const used = new Set<AssetImportField>();
  const mapping: AssetImportMapping = {};
  for (const header of headers) {
    const key = header.toLowerCase().replace(/[\s_\-.#]+/g, "");
    const field = HEADER_ALIASES[key];
    if (field && !used.has(field)) {
      mapping[header] = field;
      used.add(field);
    } else {
      mapping[header] = "skip";
    }
  }
  return mapping;
}

/** Parses the `mapping` form field: a JSON object of header -> AssetImportField, or null. */
export function parseAssetMapping(raw: string | undefined): AssetImportMapping | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  const ok = entries.every(([, v]) => typeof v === "string" && (ASSET_IMPORT_FIELDS as readonly string[]).includes(v));
  return ok ? (Object.fromEntries(entries) as AssetImportMapping) : null;
}

export interface AssetImportDraft {
  company: string;
  type: AssetType;
  name: string;
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  assignedTo: string | null;
  status: AssetStatus | null;
  seats: number | null;
  purchaseDate: Date | null;
  warrantyEndsAt: Date | null;
  renewsAt: Date | null;
  notes: string | null;
  externalId: string | null;
  clientVisible: boolean | null;
}

/** `row` is the 1-based line in the file (the header is row 1). */
export type PlannedAssetRow = { row: number; draft: AssetImportDraft } | { row: number; skip: string };

function text(value: string | undefined, max: number): string | null {
  const v = (value ?? "").trim();
  return v ? v.slice(0, max) : null;
}

function bool(value: string | undefined): boolean | null {
  const v = (value ?? "").trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["no", "n", "false", "0"].includes(v)) return false;
  return null;
}

export function planAssetImport(headers: string[], rows: string[][], mapping: AssetImportMapping): PlannedAssetRow[] {
  const col = new Map<AssetImportField, number>();
  headers.forEach((h, i) => {
    const f = mapping[h];
    if (f && f !== "skip" && !col.has(f)) col.set(f, i);
  });
  const get = (row: string[], f: AssetImportField): string | undefined => {
    const i = col.get(f);
    return i === undefined ? undefined : row[i];
  };

  return rows.map((row, i): PlannedAssetRow => {
    const line = i + 2;
    const company = text(get(row, "company"), 200);
    const name = text(get(row, "name"), ASSET_NAME_MAX);
    if (!company) return { row: line, skip: "No company" };
    if (!name) return { row: line, skip: "No name" };
    const rawType = get(row, "type") ?? "";
    const type = rawType.trim() ? parseAssetType(rawType) : "other";
    if (!type) return { row: line, skip: `Unknown type "${rawType.slice(0, 50)}"` };

    const dates: Partial<Record<"purchaseDate" | "warrantyEndsAt" | "renewsAt", Date | null>> = {};
    for (const f of ["purchaseDate", "warrantyEndsAt", "renewsAt"] as const) {
      const raw = (get(row, f) ?? "").trim();
      if (!raw) {
        dates[f] = null;
        continue;
      }
      const d = parseDateInput(raw);
      if (!d) return { row: line, skip: `Invalid date "${raw.slice(0, 40)}" (use YYYY-MM-DD)` };
      dates[f] = d;
    }

    const seatsRaw = (get(row, "seats") ?? "").trim();
    let seats: number | null = null;
    if (seatsRaw) {
      const n = Number(seatsRaw);
      if (!Number.isInteger(n) || n < 0 || n > ASSET_SEATS_MAX) return { row: line, skip: `Invalid seats "${seatsRaw.slice(0, 20)}"` };
      seats = n;
    }
    const statusRaw = (get(row, "status") ?? "").trim();

    return {
      row: line,
      draft: {
        company,
        type,
        name,
        vendor: text(get(row, "vendor"), ASSET_TEXT_MAX),
        model: text(get(row, "model"), ASSET_TEXT_MAX),
        serialNumber: text(get(row, "serialNumber"), ASSET_TEXT_MAX),
        assignedTo: text(get(row, "assignedTo"), ASSET_TEXT_MAX),
        status: statusRaw ? parseAssetStatus(statusRaw) : null,
        seats,
        purchaseDate: dates.purchaseDate ?? null,
        warrantyEndsAt: dates.warrantyEndsAt ?? null,
        renewsAt: dates.renewsAt ?? null,
        notes: text(get(row, "notes"), ASSET_NOTES_MAX),
        externalId: text(get(row, "externalId"), ASSET_EXTERNAL_ID_MAX),
        clientVisible: bool(get(row, "clientVisible")),
      },
    };
  });
}

export interface ExportableAsset {
  id: string;
  type: string;
  name: string;
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  assignedTo: string | null;
  status: string;
  seats: number | null;
  purchaseDate: Date | null;
  warrantyEndsAt: Date | null;
  renewsAt: Date | null;
  notes: string | null;
  externalSource: string | null;
  externalId: string | null;
  clientVisible: boolean;
  company: { name: string };
}

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "");

/** Column headers match the import aliases, so an export can be edited and imported back. */
const EXPORT_COLUMNS: CsvColumn<ExportableAsset>[] = [
  { header: "Company", value: (a) => a.company.name },
  { header: "Type", value: (a) => a.type },
  { header: "Name", value: (a) => a.name },
  { header: "Vendor", value: (a) => a.vendor },
  { header: "Model", value: (a) => a.model },
  { header: "Serial number", value: (a) => a.serialNumber },
  { header: "Assigned to", value: (a) => a.assignedTo },
  { header: "Status", value: (a) => a.status },
  { header: "Seats", value: (a) => a.seats },
  { header: "Purchase date", value: (a) => day(a.purchaseDate) },
  { header: "Warranty ends at", value: (a) => day(a.warrantyEndsAt) },
  { header: "Renews at", value: (a) => day(a.renewsAt) },
  { header: "Client visible", value: (a) => (a.clientVisible ? "yes" : "no") },
  { header: "External ID", value: (a) => a.externalId },
  { header: "External source", value: (a) => a.externalSource },
  { header: "Notes", value: (a) => a.notes },
];

export function assetsToCsv(assets: ExportableAsset[]): string {
  return toCsv(EXPORT_COLUMNS, assets);
}
