export const COVERAGE_PERIODS = ["monthly", "quarterly", "yearly", "term"] as const;
export type CoveragePeriod = (typeof COVERAGE_PERIODS)[number];

export const CONTRACT_STATUSES = ["draft", "active", "expired", "cancelled"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

const MONTHS: Record<Exclude<CoveragePeriod, "term">, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * `date` plus `months` calendar months in UTC, clamped to the last day of the
 * target month (Jan 31 + 1 month = Feb 28/29), keeping the time of day.
 */
export function addMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export interface Period {
  start: Date;
  /** Exclusive; null for an open-ended term. */
  end: Date | null;
}

/**
 * The coverage period containing `at`. Monthly, quarterly and yearly periods are
 * aligned to the contract start and always counted from it (so a contract starting
 * Jan 31 has periods starting Feb 28, Mar 31, Apr 30...), and the last one is cut
 * at the contract end. "term" is the whole contract. Before the start, the first
 * period is returned.
 */
export function periodAt(
  contract: { startsAt: Date; endsAt: Date | null; coveragePeriod: string },
  at: Date,
): Period {
  const { startsAt, endsAt } = contract;
  if (contract.coveragePeriod === "term" || !(contract.coveragePeriod in MONTHS)) {
    return { start: startsAt, end: endsAt };
  }
  const step = MONTHS[contract.coveragePeriod as keyof typeof MONTHS];
  if (at.getTime() < startsAt.getTime()) {
    return { start: startsAt, end: clip(addMonths(startsAt, step), endsAt) };
  }
  const monthsApart =
    (at.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 + (at.getUTCMonth() - startsAt.getUTCMonth());
  let k = Math.max(0, Math.floor(monthsApart / step));
  // The estimate can be one period off either way around month ends; settle it.
  while (k > 0 && addMonths(startsAt, k * step).getTime() > at.getTime()) k--;
  while (addMonths(startsAt, (k + 1) * step).getTime() <= at.getTime()) k++;
  const start = addMonths(startsAt, k * step);
  return { start, end: clip(addMonths(startsAt, (k + 1) * step), endsAt) };
}

function clip(end: Date, endsAt: Date | null): Date {
  return endsAt && endsAt.getTime() < end.getTime() ? endsAt : end;
}

export interface Usage {
  coveredMinutes: number | null;
  usedMinutes: number;
  remainingMinutes: number | null;
  overageMinutes: number;
  overageCents: number | null;
}

/** Covered, used, remaining and overage for one period from the summed seconds of its time entries. */
export function computeUsage(
  contract: { coveredMinutes: number | null; overageRateCents: number | null },
  usedSeconds: number,
): Usage {
  const usedMinutes = Math.round(usedSeconds / 60);
  const covered = contract.coveredMinutes;
  if (covered == null) {
    return { coveredMinutes: null, usedMinutes, remainingMinutes: null, overageMinutes: 0, overageCents: null };
  }
  const overageMinutes = Math.max(0, usedMinutes - covered);
  return {
    coveredMinutes: covered,
    usedMinutes,
    remainingMinutes: Math.max(0, covered - usedMinutes),
    overageMinutes,
    overageCents: contract.overageRateCents == null ? null : Math.ceil((overageMinutes * contract.overageRateCents) / 60),
  };
}

/** A contract's term: whole calendar months when start and end line up on them, else exact milliseconds. */
export type TermLength = { months: number } | { ms: number };

export function termLength(startsAt: Date, endsAt: Date): TermLength {
  const months =
    (endsAt.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 + (endsAt.getUTCMonth() - startsAt.getUTCMonth());
  if (months > 0 && addMonths(startsAt, months).getTime() === endsAt.getTime()) return { months };
  return { ms: endsAt.getTime() - startsAt.getTime() };
}

export function addTerm(date: Date, term: TermLength): Date {
  return "months" in term ? addMonths(date, term.months) : new Date(date.getTime() + term.ms);
}

/**
 * Renews an auto-renewing contract that reached its end: the new term starts at the
 * old end and lasts as long as the original one. Repeats until the term covers `now`
 * (a server that was down over several ends). Returns null when not due.
 */
export function renewedTerm(
  contract: { startsAt: Date; endsAt: Date | null },
  now: Date,
): { startsAt: Date; endsAt: Date; renewals: number } | null {
  const { startsAt, endsAt } = contract;
  if (!endsAt || endsAt.getTime() > now.getTime() || endsAt.getTime() <= startsAt.getTime()) return null;
  const term = termLength(startsAt, endsAt);
  let start = endsAt;
  let end = addTerm(endsAt, term);
  let renewals = 1;
  while (end.getTime() <= now.getTime() && renewals < 1000) {
    start = end;
    end = addTerm(end, term);
    renewals++;
  }
  return { startsAt: start, endsAt: end, renewals };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** An active contract with an end date inside its notice window that has not been notified this term. */
export function needsRenewalNotice(
  contract: { status: string; endsAt: Date | null; renewalNoticeDays: number; renewalNotifiedAt: Date | null; startsAt: Date },
  now: Date,
): boolean {
  if (contract.status !== "active" || !contract.endsAt) return false;
  const end = contract.endsAt.getTime();
  if (end <= now.getTime() || end > now.getTime() + contract.renewalNoticeDays * DAY_MS) return false;
  return !contract.renewalNotifiedAt || contract.renewalNotifiedAt.getTime() < contract.startsAt.getTime();
}
