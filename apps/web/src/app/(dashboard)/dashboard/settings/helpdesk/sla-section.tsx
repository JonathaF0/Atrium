"use client";

import { useState } from "react";
import { TICKET_PRIORITIES } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { priorityLabel } from "@/lib/tickets";
import { Section, buttonClass, inputClass, primaryButton, smallInput, type Calendar, type SlaPolicy, type Staff } from "./shared";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toHours = (mins: number): string => String(Math.round((mins / 60) * 100) / 100);
const toMins = (hours: string): number => Math.max(1, Math.round(Number(hours) * 60));

function PolicyEditor({
  policy,
  calendars,
  staff,
  onSaved,
}: {
  policy: SlaPolicy | null;
  calendars: Calendar[];
  staff: Staff[];
  onSaved: () => Promise<void>;
}): React.ReactElement {
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(policy?.name ?? "");
  const [targets, setTargets] = useState<Record<string, { first: string; resolve: string }>>(() =>
    Object.fromEntries(
      TICKET_PRIORITIES.map((p) => [
        p,
        { first: toHours(policy?.targets[p]?.firstResponseMins ?? 480), resolve: toHours(policy?.targets[p]?.resolutionMins ?? 2400) },
      ]),
    ),
  );
  const [businessHoursId, setBusinessHoursId] = useState(policy?.businessHoursId ?? "");
  const [warnAtPercent, setWarn] = useState(String(policy?.warnAtPercent ?? 80));
  const [escalateToId, setEscalate] = useState(policy?.escalateToId ?? "");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const body = {
        name,
        targets: Object.fromEntries(TICKET_PRIORITIES.map((p) => [p, { firstResponseMins: toMins(targets[p].first), resolutionMins: toMins(targets[p].resolve) }])),
        businessHoursId: businessHoursId || null,
        warnAtPercent: Number(warnAtPercent),
        escalateToId: escalateToId || null,
      };
      await apiFetch(policy ? `/helpdesk/sla-policies/${policy.id}` : "/helpdesk/sla-policies", { method: policy ? "PATCH" : "POST", body: JSON.stringify(body) });
      toast.success("SLA policy saved");
      if (!policy) setName("");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-[var(--border)] rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap gap-2 items-end">
        <label className="text-sm flex-1 min-w-[160px]">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className={inputClass} placeholder="Policy name" />
        </label>
        <label className="text-sm">
          Business hours
          <select value={businessHoursId} onChange={(e) => setBusinessHoursId(e.target.value)} className={smallInput + " block"}>
            <option value="">Around the clock</option>
            {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          Warn at %
          <input type="number" min={1} max={99} value={warnAtPercent} onChange={(e) => setWarn(e.target.value)} className={smallInput + " block w-20"} />
        </label>
        <label className="text-sm">
          Escalate to
          <select value={escalateToId} onChange={(e) => setEscalate(e.target.value)} className={smallInput + " block"}>
            <option value="">Nobody extra</option>
            {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
          </select>
        </label>
      </div>
      <table className="text-sm w-full max-w-lg">
        <thead className="text-xs text-[var(--muted-foreground)] text-left">
          <tr><th className="py-1">Priority</th><th>First response (hours)</th><th>Resolution (hours)</th></tr>
        </thead>
        <tbody>
          {TICKET_PRIORITIES.map((p) => (
            <tr key={p}>
              <td className="py-1">{priorityLabel(p)}</td>
              <td><input aria-label={`${p} first response hours`} type="number" min={0.1} step={0.25} value={targets[p].first} onChange={(e) => setTargets({ ...targets, [p]: { ...targets[p], first: e.target.value } })} className={smallInput + " w-24"} /></td>
              <td><input aria-label={`${p} resolution hours`} type="number" min={0.1} step={0.25} value={targets[p].resolve} onChange={(e) => setTargets({ ...targets, [p]: { ...targets[p], resolve: e.target.value } })} className={smallInput + " w-24"} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-[var(--muted-foreground)]">Hours are business hours of the chosen calendar.</p>
      <div className="flex gap-2">
        <button type="button" disabled={saving || !name.trim()} onClick={() => void save()} className={primaryButton}>{policy ? "Save" : "Add policy"}</button>
        {policy && (
          <button
            type="button"
            className={buttonClass + " text-red-600"}
            onClick={async () => {
              if (!(await confirm({ title: "Delete policy", message: `Delete "${policy.name}"? Tickets using it keep their due dates.`, confirmLabel: "Delete", variant: "danger" }))) return;
              try {
                await apiFetch(`/helpdesk/sla-policies/${policy.id}`, { method: "DELETE" });
                await onSaved();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Delete failed");
              }
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

export function SlaSection({ policies, calendars, staff, onChange }: { policies: SlaPolicy[]; calendars: Calendar[]; staff: Staff[]; onChange: () => Promise<void> }): React.ReactElement {
  return (
    <Section title="SLA policies" description="Response and resolution targets per priority. A category's policy wins over the workspace default.">
      {policies.map((p) => <PolicyEditor key={`${p.id}-${JSON.stringify(p)}`} policy={p} calendars={calendars} staff={staff} onSaved={onChange} />)}
      <details>
        <summary className="cursor-pointer text-sm font-medium">Add a policy</summary>
        <div className="mt-2"><PolicyEditor policy={null} calendars={calendars} staff={staff} onSaved={onChange} /></div>
      </details>
    </Section>
  );
}

function CalendarEditor({ calendar, onSaved }: { calendar: Calendar | null; onSaved: () => Promise<void> }): React.ReactElement {
  const toast = useToast();
  const [name, setName] = useState(calendar?.name ?? "");
  const [timezone, setTimezone] = useState(calendar?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  const [days, setDays] = useState<Record<number, { on: boolean; start: string; end: string }>>(() =>
    Object.fromEntries(
      DAYS.map((_, day) => {
        const w = calendar?.schedule.find((s) => s.day === day);
        return [day, { on: calendar ? !!w : day >= 1 && day <= 5, start: w?.start ?? "09:00", end: w?.end ?? "17:00" }];
      }),
    ),
  );
  const [holidayDate, setHolidayDate] = useState("");
  const [holidayName, setHolidayName] = useState("");

  const save = async (): Promise<void> => {
    try {
      const schedule = DAYS.map((_, day) => ({ day, ...days[day] })).filter((d) => d.on).map(({ day, start, end }) => ({ day, start, end }));
      await apiFetch(calendar ? `/helpdesk/business-hours/${calendar.id}` : "/helpdesk/business-hours", { method: calendar ? "PUT" : "POST", body: JSON.stringify({ name, timezone, schedule }) });
      toast.success("Business hours saved");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };

  return (
    <div className="border border-[var(--border)] rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        <label className="text-sm flex-1 min-w-[160px]">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className={inputClass} /></label>
        <label className="text-sm flex-1 min-w-[160px]">Time zone<input value={timezone} onChange={(e) => setTimezone(e.target.value)} maxLength={100} className={inputClass} placeholder="e.g. Europe/Berlin" /></label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {DAYS.map((label, day) => (
          <div key={day} className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-1 w-16"><input type="checkbox" checked={days[day].on} onChange={(e) => setDays({ ...days, [day]: { ...days[day], on: e.target.checked } })} />{label}</label>
            <input type="time" aria-label={`${label} start`} disabled={!days[day].on} value={days[day].start} onChange={(e) => setDays({ ...days, [day]: { ...days[day], start: e.target.value } })} className={smallInput} />
            <span>–</span>
            <input type="time" aria-label={`${label} end`} disabled={!days[day].on} value={days[day].end} onChange={(e) => setDays({ ...days, [day]: { ...days[day], end: e.target.value } })} className={smallInput} />
          </div>
        ))}
      </div>
      <button type="button" disabled={!name.trim()} onClick={() => void save()} className={primaryButton}>{calendar ? "Save hours" : "Add calendar"}</button>
      {calendar && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Holidays</h3>
          <ul className="text-sm space-y-1">
            {calendar.holidays.map((h) => (
              <li key={h.id} className="flex items-center gap-2">
                <span>{h.date.slice(0, 10)} {h.name}</span>
                <button type="button" aria-label={`Remove ${h.name}`} className="text-xs text-red-600" onClick={() => void apiFetch(`/helpdesk/business-hours/${calendar.id}/holidays/${h.id}`, { method: "DELETE" }).then(onSaved)}>Remove</button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <input type="date" aria-label="Holiday date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} className={smallInput} />
            <input aria-label="Holiday name" value={holidayName} onChange={(e) => setHolidayName(e.target.value)} maxLength={100} placeholder="Holiday name" className={smallInput} />
            <button
              type="button"
              disabled={!holidayDate || !holidayName.trim()}
              className={buttonClass}
              onClick={async () => {
                try {
                  await apiFetch(`/helpdesk/business-hours/${calendar.id}/holidays`, { method: "POST", body: JSON.stringify({ date: holidayDate, name: holidayName }) });
                  setHolidayDate("");
                  setHolidayName("");
                  await onSaved();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Could not add holiday");
                }
              }}
            >
              Add holiday
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function BusinessHoursSection({ calendars, onChange }: { calendars: Calendar[]; onChange: () => Promise<void> }): React.ReactElement {
  return (
    <Section title="Business hours" description="SLA clocks only run during these hours. Holidays are skipped.">
      {calendars.map((c) => <CalendarEditor key={`${c.id}-${JSON.stringify(c)}`} calendar={c} onSaved={onChange} />)}
      <details>
        <summary className="cursor-pointer text-sm font-medium">Add a calendar</summary>
        <div className="mt-2"><CalendarEditor calendar={null} onSaved={onChange} /></div>
      </details>
    </Section>
  );
}
