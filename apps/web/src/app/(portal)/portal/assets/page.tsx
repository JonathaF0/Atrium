"use client";

import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { ProjectCardSkeleton } from "@/components/skeletons";
import {
  ASSET_STATUS_LABELS,
  ASSET_TYPE_LABELS,
  dueClass,
  formatDay,
} from "../../../(dashboard)/dashboard/assets/shared";
import type { AssetType } from "../../../(dashboard)/dashboard/assets/shared";

interface PortalAsset {
  id: string;
  type: AssetType;
  name: string;
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  assignedTo: string | null;
  status: string;
  seats: number | null;
  purchaseDate: string | null;
  warrantyEndsAt: string | null;
  renewsAt: string | null;
}

export default function PortalAssetsPage() {
  const [assets, setAssets] = useState<PortalAsset[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<PortalAsset[]>("/assets/mine")
      .then(setAssets)
      .catch((err) => {
        console.error(err);
        setError("Couldn't load your assets.");
      });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Assets</h1>
        <p className="text-sm text-[var(--muted-foreground)]">
          Devices, licenses and services we manage for your company, with warranty and renewal dates.
        </p>
      </div>
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : assets === null ? (
        <div className="space-y-3">
          <ProjectCardSkeleton />
          <ProjectCardSkeleton />
        </div>
      ) : assets.length === 0 ? (
        <div className="py-16 text-center text-[var(--muted-foreground)]">
          <HardDrive className="mx-auto mb-3" size={32} />
          <p>No assets on record yet.</p>
        </div>
      ) : (
        <div className="border border-[var(--border)] rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted-foreground)] border-b border-[var(--border)]">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium hidden sm:table-cell">Details</th>
                <th className="px-4 py-2 font-medium">Warranty ends</th>
                <th className="px-4 py-2 font-medium">Renews</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {assets.map((a) => (
                <tr key={a.id} data-testid="portal-asset-row">
                  <td className="px-4 py-3 font-medium">{a.name}</td>
                  <td className="px-4 py-3">{ASSET_TYPE_LABELS[a.type] ?? a.type}</td>
                  <td className="px-4 py-3 hidden sm:table-cell text-[var(--muted-foreground)]">
                    {[a.vendor, a.model, a.serialNumber, a.assignedTo].filter(Boolean).join(" · ")}
                    {a.seats != null && ` · ${a.seats} seats`}
                  </td>
                  <td className={`px-4 py-3 ${a.warrantyEndsAt ? dueClass(a.warrantyEndsAt) : ""}`}>
                    {formatDay(a.warrantyEndsAt) || "-"}
                  </td>
                  <td className={`px-4 py-3 ${a.renewsAt ? dueClass(a.renewsAt) : ""}`}>{formatDay(a.renewsAt) || "-"}</td>
                  <td className="px-4 py-3">{ASSET_STATUS_LABELS[a.status] ?? a.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
