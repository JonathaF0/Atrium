import { ASSET_TYPES } from "@atrium/shared";
import type { AssetType } from "@atrium/shared";

export const ASSET_STATUSES = ["active", "retired", "expired"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** Types whose end date is a hard expiry rather than a warranty: flagged "expired" once it passes. */
export const EXPIRING_ASSET_TYPES: readonly AssetType[] = ["software_license", "ssl_certificate", "domain"];

export const ASSET_NAME_MAX = 200;
export const ASSET_TEXT_MAX = 200;
export const ASSET_NOTES_MAX = 5000;
export const ASSET_EXTERNAL_ID_MAX = 200;
export const ASSET_SEATS_MAX = 1_000_000;

export const METADATA_MAX_KEYS = 50;
export const METADATA_KEY_MAX = 100;
export const METADATA_STRING_MAX = 1000;
export const METADATA_MAX_BYTES = 8 * 1024;

export type AssetMetadata = Record<string, string | number | boolean>;

/**
 * Checks free-form asset metadata: a plain object of at most 50 keys whose values
 * are strings, finite numbers or booleans, within a size cap. Returns an error
 * message, or null when valid.
 */
export function metadataError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "metadata must be an object";
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "metadata must be a plain object";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > METADATA_MAX_KEYS) return `metadata may have at most ${METADATA_MAX_KEYS} keys`;
  for (const [key, v] of entries) {
    if (key.length === 0 || key.length > METADATA_KEY_MAX) {
      return `metadata keys must be 1-${METADATA_KEY_MAX} characters`;
    }
    if (typeof v === "string") {
      if (v.length > METADATA_STRING_MAX) return `metadata "${key.slice(0, 50)}" is too long`;
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) return `metadata "${key.slice(0, 50)}" must be a finite number`;
    } else if (typeof v !== "boolean") {
      return `metadata "${key.slice(0, 50)}" must be a string, number or boolean`;
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > METADATA_MAX_BYTES) {
    return `metadata must be at most ${METADATA_MAX_BYTES} bytes`;
  }
  return null;
}

export function isAssetType(value: string): value is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(value);
}

/** Free-text type from a CSV or connector ("SSL Certificate", "license") to an AssetType. */
export function parseAssetType(value: string): AssetType | null {
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (isAssetType(v)) return v;
  const aliases: Record<string, AssetType> = {
    license: "software_license",
    licence: "software_license",
    software: "software_license",
    software_licence: "software_license",
    ssl: "ssl_certificate",
    certificate: "ssl_certificate",
    cert: "ssl_certificate",
    tls_certificate: "ssl_certificate",
    cloud: "cloud_service",
    saas: "cloud_service",
    subscription: "cloud_service",
    hardware: "device",
    computer: "device",
    laptop: "device",
    server: "device",
    workstation: "device",
    printer: "device",
    domain_name: "domain",
  };
  return aliases[v] ?? null;
}

export function parseAssetStatus(value: string): AssetStatus | null {
  const v = value.trim().toLowerCase();
  return (ASSET_STATUSES as readonly string[]).includes(v) ? (v as AssetStatus) : null;
}

/** The asset's alertable end dates that fall inside [now, now + days]. */
export interface RenewalDate {
  kind: "warranty" | "renewal";
  date: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which of an asset's dates need a renewal notice now. A date is due when it lies within
 * the notice window and the asset was not already notified inside that date's window
 * (renewalNotifiedAt before the window opened means it belonged to an earlier cycle).
 */
export function dueRenewalDates(
  asset: { warrantyEndsAt: Date | null; renewsAt: Date | null; renewalNotifiedAt: Date | null; status: string },
  now: Date,
  noticeDays: number,
): RenewalDate[] {
  if (asset.status === "retired") return [];
  const horizon = now.getTime() + noticeDays * DAY_MS;
  const out: RenewalDate[] = [];
  const candidates: RenewalDate[] = [];
  if (asset.renewsAt) candidates.push({ kind: "renewal", date: asset.renewsAt });
  if (asset.warrantyEndsAt) candidates.push({ kind: "warranty", date: asset.warrantyEndsAt });
  for (const c of candidates) {
    const t = c.date.getTime();
    if (t < now.getTime() || t > horizon) continue;
    const windowOpens = t - noticeDays * DAY_MS;
    if (asset.renewalNotifiedAt && asset.renewalNotifiedAt.getTime() >= windowOpens) continue;
    out.push(c);
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** The date after which an expiring-type asset counts as expired: renewsAt, else warrantyEndsAt. */
export function expiryDate(asset: { type: string; renewsAt: Date | null; warrantyEndsAt: Date | null }): Date | null {
  if (!(EXPIRING_ASSET_TYPES as readonly string[]).includes(asset.type)) return null;
  return asset.renewsAt ?? asset.warrantyEndsAt ?? null;
}

/** "YYYY-MM-DD" or a full ISO timestamp to a Date; null when unparseable. */
export function parseDateInput(value: string): Date | null {
  const v = value.trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
