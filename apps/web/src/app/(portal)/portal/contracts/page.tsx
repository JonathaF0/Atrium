"use client";

import { useEffect, useState } from "react";
import { FileSignature } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { ProjectCardSkeleton } from "@/components/skeletons";
import { UsageBar } from "../../../(dashboard)/dashboard/contracts/usage-bar";
import {
  CONTRACT_TYPE_LABELS,
  COVERAGE_PERIOD_LABELS,
  formatDay,
  formatMinutes,
} from "../../../(dashboard)/dashboard/contracts/shared";
import type { ContractType } from "../../../(dashboard)/dashboard/contracts/shared";

interface PortalContract {
  id: string;
  name: string;
  type: ContractType;
  startsAt: string;
  endsAt: string | null;
  autoRenew: boolean;
  includedServices: string[];
  coveragePeriod: string;
  coveredMinutes: number | null;
  usage: {
    period: { start: string; end: string | null; coveragePeriod: string };
    usedMinutes: number;
    remainingMinutes: number | null;
  } | null;
}

export default function PortalContractsPage() {
  const [contracts, setContracts] = useState<PortalContract[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<PortalContract[]>("/contracts/mine")
      .then(setContracts)
      .catch((err) => {
        console.error(err);
        setError("Couldn't load your contracts.");
      });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Contracts</h1>
        <p className="text-sm text-[var(--muted-foreground)]">Your company&apos;s service agreements and included hours.</p>
      </div>
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : contracts === null ? (
        <ProjectCardSkeleton />
      ) : contracts.length === 0 ? (
        <div className="py-16 text-center text-[var(--muted-foreground)]">
          <FileSignature className="mx-auto mb-3" size={32} />
          <p>No active contracts.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {contracts.map((c) => (
            <article key={c.id} className="border border-[var(--border)] rounded-xl p-5 space-y-3" data-testid="portal-contract">
              <div>
                <h2 className="font-semibold">{c.name}</h2>
                <p className="text-sm text-[var(--muted-foreground)]">
                  {CONTRACT_TYPE_LABELS[c.type] ?? c.type} · {formatDay(c.startsAt)} –{" "}
                  {c.endsAt ? formatDay(c.endsAt) : "ongoing"}
                  {c.autoRenew && c.endsAt ? " (renews automatically)" : ""}
                </p>
              </div>
              {c.coveredMinutes != null && (
                <div className="space-y-1">
                  <p className="text-sm">
                    {formatMinutes(c.coveredMinutes)} of support included {COVERAGE_PERIOD_LABELS[c.coveragePeriod] ?? ""}
                  </p>
                  {c.usage && (
                    <UsageBar
                      usage={{
                        ...c.usage,
                        coveredMinutes: c.coveredMinutes,
                        overageMinutes: Math.max(0, c.usage.usedMinutes - c.coveredMinutes),
                        overageCents: null,
                      }}
                    />
                  )}
                </div>
              )}
              {c.includedServices.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)] mb-1">
                    Included services
                  </h3>
                  <ul className="list-disc pl-5 text-sm space-y-0.5">
                    {c.includedServices.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
