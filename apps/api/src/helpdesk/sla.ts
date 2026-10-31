import {
  DEFAULT_SLA_TARGETS,
  SLA_PAUSED_STATUSES,
  TICKET_DONE_STATUSES,
  TICKET_PRIORITIES,
  type SlaTarget,
  type SlaTargets,
  type TicketPriority,
  type TicketStatus,
} from "@atrium/shared";
import { ALWAYS_OPEN, addBusinessMinutes, businessMinutesBetween, isValidSchedule } from "../service-core";
import type { BusinessCalendar } from "../service-core";

/**
 * SLA clock rules.
 *
 * Due dates are always derived from the ticket's creation time:
 *   due = createdAt + (target + paused) business minutes
 * where `paused` is the business time the ticket spent waiting (on the
 * client, a third party, on hold) or resolved before being reopened. Pausing
 * therefore pushes the due dates out by exactly the business time lost, and a
 * priority change recomputes them from the same formula.
 */

/** Statuses during which the clock does not run: the paused ones plus resolved/closed. */
export function clockStopped(status: string): boolean {
  return (
    (SLA_PAUSED_STATUSES as readonly string[]).includes(status) ||
    (TICKET_DONE_STATUSES as readonly string[]).includes(status)
  );
}

export function parseTargets(raw: unknown): SlaTargets {
  const out = { ...DEFAULT_SLA_TARGETS } as SlaTargets;
  if (!raw || typeof raw !== "object") return out;
  for (const p of TICKET_PRIORITIES) {
    const t = (raw as Record<string, unknown>)[p] as Partial<SlaTarget> | undefined;
    if (
      t &&
      Number.isInteger(t.firstResponseMins) &&
      Number.isInteger(t.resolutionMins) &&
      (t.firstResponseMins as number) > 0 &&
      (t.resolutionMins as number) > 0
    ) {
      out[p] = { firstResponseMins: t.firstResponseMins as number, resolutionMins: t.resolutionMins as number };
    }
  }
  return out;
}

export function isValidTargets(raw: unknown): raw is SlaTargets {
  if (!raw || typeof raw !== "object") return false;
  return TICKET_PRIORITIES.every((p) => {
    const t = (raw as Record<string, unknown>)[p] as Partial<SlaTarget> | undefined;
    return (
      !!t &&
      Number.isInteger(t.firstResponseMins) &&
      Number.isInteger(t.resolutionMins) &&
      (t.firstResponseMins as number) > 0 &&
      (t.resolutionMins as number) > 0 &&
      (t.firstResponseMins as number) <= 525_600 &&
      (t.resolutionMins as number) <= 525_600
    );
  });
}

export interface CalendarSource {
  timezone: string;
  schedule: unknown;
  holidays: { date: Date }[];
}

export function toCalendar(source: CalendarSource | null | undefined): BusinessCalendar {
  if (!source || !isValidSchedule(source.schedule) || source.schedule.length === 0) return ALWAYS_OPEN;
  return {
    timezone: source.timezone,
    schedule: source.schedule,
    holidays: source.holidays.map((h) => h.date.toISOString().slice(0, 10)),
  };
}

export interface SlaDue {
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
}

export function computeDueDates(
  createdAt: Date,
  priority: string,
  targets: SlaTargets,
  pausedSeconds: number,
  cal: BusinessCalendar,
): SlaDue {
  const target: SlaTarget = targets[(priority as TicketPriority)] ?? targets.normal;
  const paused: number = Math.floor(pausedSeconds / 60);
  return {
    firstResponseDueAt: addBusinessMinutes(createdAt, target.firstResponseMins + paused, cal),
    resolutionDueAt: addBusinessMinutes(createdAt, target.resolutionMins + paused, cal),
  };
}

/** Instant at which `percent` of the target has been used, given the time already paused. */
export function warnAt(
  createdAt: Date,
  targetMins: number,
  percent: number,
  pausedSeconds: number,
  cal: BusinessCalendar,
): Date | null {
  const used: number = Math.floor((targetMins * Math.min(Math.max(percent, 1), 100)) / 100);
  return addBusinessMinutes(createdAt, used + Math.floor(pausedSeconds / 60), cal);
}

export interface SlaClockState {
  createdAt: Date;
  priority: string;
  status: string;
  slaPausedAt: Date | null;
  slaPausedSeconds: number;
}

/**
 * Fields to write when a ticket's status changes, as far as the SLA clock is
 * concerned. Entering a stopped status records `slaPausedAt`; leaving it adds
 * the business time spent stopped to `slaPausedSeconds` and recomputes the due
 * dates. Returns an empty object when nothing changes.
 */
export function slaOnStatusChange(
  ticket: SlaClockState,
  nextStatus: TicketStatus | string,
  now: Date,
  targets: SlaTargets | null,
  cal: BusinessCalendar,
): Partial<{
  slaPausedAt: Date | null;
  slaPausedSeconds: number;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  slaWarnedAt: null;
}> {
  const wasStopped: boolean = clockStopped(ticket.status);
  const willStop: boolean = clockStopped(nextStatus);
  if (!wasStopped && willStop) return { slaPausedAt: now };
  if (wasStopped && !willStop) {
    const since: Date = ticket.slaPausedAt ?? now;
    const pausedSeconds: number = ticket.slaPausedSeconds + businessMinutesBetween(since, now, cal) * 60;
    if (!targets) return { slaPausedAt: null, slaPausedSeconds: pausedSeconds };
    return {
      slaPausedAt: null,
      slaPausedSeconds: pausedSeconds,
      ...computeDueDates(ticket.createdAt, ticket.priority, targets, pausedSeconds, cal),
      slaWarnedAt: null,
    };
  }
  return {};
}
