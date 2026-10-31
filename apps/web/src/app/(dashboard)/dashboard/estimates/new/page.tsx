"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { EstimateBuilder, emptyLine, type BuilderForm } from "../estimate-builder";

interface EstimateSettings {
  estimateValidDays: number;
  estimateDefaultTerms: string | null;
  defaultTaxRateBps: number;
}

function dateInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function NewEstimate() {
  const params = useSearchParams();
  const [settings, setSettings] = useState<EstimateSettings | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<EstimateSettings>("/estimates/settings")
      .then(setSettings)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load settings"));
  }, []);

  if (error) return <div className="p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>;
  if (!settings) return <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>;

  const initial: BuilderForm = {
    title: "",
    introduction: "",
    companyId: params.get("companyId") ?? "",
    recipientUserId: params.get("recipientUserId") ?? "",
    projectId: params.get("projectId") ?? "",
    ticketId: params.get("ticketId") ?? "",
    discountType: "",
    discountValue: "",
    depositPercent: "",
    assumptions: "",
    exclusions: "",
    terms: settings.estimateDefaultTerms ?? "",
    validUntil: dateInput(new Date(Date.now() + settings.estimateValidDays * 86_400_000)),
    aiDrafted: false,
    lines: [emptyLine(settings.defaultTaxRateBps)],
  };
  return <EstimateBuilder initial={initial} defaultTax={settings.defaultTaxRateBps} />;
}

export default function NewEstimatePage() {
  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/estimates" className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
          <ArrowLeft size={14} /> Estimates
        </Link>
        <h1 className="text-2xl font-bold mt-2">New estimate</h1>
      </div>
      <Suspense fallback={<p className="text-sm text-[var(--muted-foreground)]">Loading...</p>}>
        <NewEstimate />
      </Suspense>
    </div>
  );
}
