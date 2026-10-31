import { ESTIMATE_STATUS_COLORS, ESTIMATE_STATUS_LABELS } from "@/lib/estimates";

export function EstimateStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${ESTIMATE_STATUS_COLORS[status] ?? ""}`}>
      {ESTIMATE_STATUS_LABELS[status] ?? status}
    </span>
  );
}
