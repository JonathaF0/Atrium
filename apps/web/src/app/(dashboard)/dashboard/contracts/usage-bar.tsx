import { formatMinutes, periodLabel, usagePercent } from "./shared";
import type { ContractUsage } from "./shared";

/** Covered hours used / remaining for one period. */
export function UsageBar({ usage }: { usage: ContractUsage }) {
  if (usage.coveredMinutes == null) return null;
  const pct = usagePercent(usage);
  const over = usage.overageMinutes > 0;
  return (
    <div className="space-y-1" data-testid="contract-usage">
      <div className="flex justify-between text-xs text-[var(--muted-foreground)] gap-2">
        <span>
          {formatMinutes(usage.usedMinutes)} used of {formatMinutes(usage.coveredMinutes)}
        </span>
        <span>
          {over
            ? `${formatMinutes(usage.overageMinutes)} over`
            : `${formatMinutes(usage.remainingMinutes ?? 0)} remaining`}
        </span>
      </div>
      <div
        className="h-2 rounded-full bg-[var(--muted)] overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Covered hours used"
      >
        <div className={`h-full ${over ? "bg-red-500" : "bg-[var(--primary)]"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-[var(--muted-foreground)]">{periodLabel(usage.period)}</p>
    </div>
  );
}
