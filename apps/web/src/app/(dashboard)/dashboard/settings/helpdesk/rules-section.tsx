"use client";

import { useEffect, useState } from "react";
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_FIELDS,
  AUTOMATION_OPS,
  CANNED_RESPONSE_VARIABLES,
  TICKET_PRIORITIES,
  TICKET_SOURCES,
  TICKET_STATUSES,
  type AutomationAction,
  type AutomationCondition,
} from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import { priorityLabel, statusLabel } from "@/lib/tickets";
import { Section, buttonClass, inputClass, primaryButton, smallInput, type Category, type Staff } from "./shared";

interface Rule {
  id: string;
  name: string;
  trigger: string;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  enabled: boolean;
  order: number;
}

interface Canned {
  id: string;
  title: string;
  body: string;
  ownerId: string | null;
}

const FIELD_LABELS: Record<string, string> = { categoryId: "Category", priority: "Priority", source: "Source", companyId: "Company id", subject: "Subject", status: "Status" };
const OP_LABELS: Record<string, string> = { eq: "is", neq: "is not", contains: "contains" };
const ACTION_LABELS: Record<string, string> = { set_priority: "Set priority", assign: "Assign to", set_category: "Set category", add_label: "Add label", set_status: "Set status" };

function ValueInput({
  kind,
  value,
  onChange,
  categories,
  staff,
  labels,
}: {
  kind: string;
  value: string;
  onChange: (v: string) => void;
  categories: Category[];
  staff: Staff[];
  labels: { id: string; name: string }[];
}): React.ReactElement {
  const options: { v: string; l: string }[] | null =
    kind === "priority" || kind === "set_priority"
      ? TICKET_PRIORITIES.map((p) => ({ v: p, l: priorityLabel(p) }))
      : kind === "status" || kind === "set_status"
        ? TICKET_STATUSES.map((s) => ({ v: s, l: statusLabel(s) }))
        : kind === "source"
          ? TICKET_SOURCES.map((s) => ({ v: s, l: s }))
          : kind === "categoryId" || kind === "set_category"
            ? categories.map((c) => ({ v: c.id, l: c.name }))
            : kind === "assign"
              ? staff.map((s) => ({ v: s.userId, l: s.name }))
              : kind === "add_label"
                ? labels.map((l) => ({ v: l.id, l: l.name }))
                : null;
  if (!options) return <input aria-label="Value" value={value} onChange={(e) => onChange(e.target.value)} maxLength={200} className={smallInput} />;
  return (
    <select aria-label="Value" value={value} onChange={(e) => onChange(e.target.value)} className={smallInput}>
      <option value="">Choose...</option>
      {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}

export function RulesSection({ categories, staff }: { categories: Category[]; staff: Staff[] }): React.ReactElement {
  const toast = useToast();
  const [rules, setRules] = useState<Rule[]>([]);
  const [labels, setLabels] = useState<{ id: string; name: string }[]>([]);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("ticket_created");
  const [conditions, setConditions] = useState<AutomationCondition[]>([]);
  const [actions, setActions] = useState<AutomationAction[]>([{ type: "set_priority", value: "" }]);

  const load = async (): Promise<void> => {
    setRules(await apiFetch<Rule[]>("/helpdesk/automation-rules").catch(() => []));
  };
  useEffect(() => {
    void load();
    apiFetch<{ id: string; name: string }[]>("/labels").then(setLabels).catch(() => undefined);
  }, []);

  const create = async (): Promise<void> => {
    try {
      await apiFetch("/helpdesk/automation-rules", { method: "POST", body: JSON.stringify({ name, trigger, conditions, actions }) });
      setName("");
      setConditions([]);
      setActions([{ type: "set_priority", value: "" }]);
      toast.success("Rule added");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the rule");
    }
  };

  const describe = (r: Rule): string => {
    const conds = r.conditions.map((c) => `${FIELD_LABELS[c.field]} ${OP_LABELS[c.op]} "${c.field === "categoryId" ? (categories.find((x) => x.id === c.value)?.name ?? c.value) : c.value}"`).join(" and ") || "always";
    const acts = r.actions.map((a) => `${ACTION_LABELS[a.type]} ${a.type === "assign" ? (staff.find((s) => s.userId === a.value)?.name ?? a.value) : a.type === "set_category" ? (categories.find((c) => c.id === a.value)?.name ?? a.value) : a.type === "add_label" ? (labels.find((l) => l.id === a.value)?.name ?? a.value) : a.value}`).join(", ");
    return `When ${r.trigger === "ticket_created" ? "created" : "updated"}, if ${conds}: ${acts}`;
  };

  return (
    <Section title="Automation rules" description="Rules run in order when a ticket is created or updated by someone. Changes made by rules never trigger more rules.">
      <ul className="space-y-2">
        {rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm border border-[var(--border)] rounded-lg p-3">
            <span className="font-medium">{r.name}</span>
            <span className="text-xs text-[var(--muted-foreground)] flex-1 min-w-[200px]">{describe(r)}</span>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={r.enabled} onChange={(e) => void apiFetch(`/helpdesk/automation-rules/${r.id}`, { method: "PATCH", body: JSON.stringify({ enabled: e.target.checked }) }).then(load)} />
              Enabled
            </label>
            <button type="button" className="text-xs text-red-600" onClick={() => void apiFetch(`/helpdesk/automation-rules/${r.id}`, { method: "DELETE" }).then(load)}>Delete</button>
          </li>
        ))}
      </ul>
      <div className="border border-[var(--border)] rounded-lg p-4 space-y-2">
        <h3 className="text-sm font-medium">New rule</h3>
        <div className="flex flex-wrap gap-2">
          <input aria-label="Rule name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Rule name" className={smallInput + " flex-1 min-w-[160px]"} />
          <select aria-label="Trigger" value={trigger} onChange={(e) => setTrigger(e.target.value)} className={smallInput}>
            <option value="ticket_created">When a ticket is created</option>
            <option value="ticket_updated">When a ticket is updated</option>
          </select>
        </div>
        {conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap gap-2 items-center text-sm">
            <span className="w-10 text-xs text-[var(--muted-foreground)]">{i === 0 ? "If" : "and"}</span>
            <select aria-label="Field" value={c.field} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, field: e.target.value as AutomationCondition["field"], value: "" } : x)))} className={smallInput}>
              {AUTOMATION_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
            </select>
            <select aria-label="Operator" value={c.op} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, op: e.target.value as AutomationCondition["op"] } : x)))} className={smallInput}>
              {AUTOMATION_OPS.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
            </select>
            <ValueInput kind={c.field} value={c.value} onChange={(v) => setConditions(conditions.map((x, j) => (j === i ? { ...x, value: v } : x)))} categories={categories} staff={staff} labels={labels} />
            <button type="button" className="text-xs" onClick={() => setConditions(conditions.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" className={buttonClass} onClick={() => setConditions([...conditions, { field: "subject", op: "contains", value: "" }])}>Add condition</button>
        {actions.map((a, i) => (
          <div key={i} className="flex flex-wrap gap-2 items-center text-sm">
            <span className="w-10 text-xs text-[var(--muted-foreground)]">Then</span>
            <select aria-label="Action" value={a.type} onChange={(e) => setActions(actions.map((x, j) => (j === i ? { type: e.target.value as AutomationAction["type"], value: "" } : x)))} className={smallInput}>
              {AUTOMATION_ACTIONS.map((t) => <option key={t} value={t}>{ACTION_LABELS[t]}</option>)}
            </select>
            <ValueInput kind={a.type} value={a.value} onChange={(v) => setActions(actions.map((x, j) => (j === i ? { ...x, value: v } : x)))} categories={categories} staff={staff} labels={labels} />
            {actions.length > 1 && <button type="button" className="text-xs" onClick={() => setActions(actions.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={() => setActions([...actions, { type: "add_label", value: "" }])}>Add action</button>
          <button type="button" className={primaryButton} disabled={!name.trim() || actions.some((a) => !a.value)} onClick={() => void create()}>Save rule</button>
        </div>
      </div>
    </Section>
  );
}

export function CannedSection(): React.ReactElement {
  const toast = useToast();
  const [items, setItems] = useState<Canned[]>([]);
  const [editing, setEditing] = useState<Canned | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [personal, setPersonal] = useState(false);

  const load = async (): Promise<void> => {
    setItems(await apiFetch<Canned[]>("/helpdesk/canned-responses").catch(() => []));
  };
  useEffect(() => {
    void load();
  }, []);

  const startEdit = (c: Canned | null): void => {
    setEditing(c);
    setTitle(c?.title ?? "");
    setBody(c?.body ?? "");
    setPersonal(!!c?.ownerId);
  };

  const save = async (): Promise<void> => {
    try {
      await apiFetch(editing ? `/helpdesk/canned-responses/${editing.id}` : "/helpdesk/canned-responses", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify({ title, body, personal }),
      });
      startEdit(null);
      toast.success("Response saved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };

  return (
    <Section title="Canned responses" description="Reusable replies for the ticket composer. Personal responses are visible only to you.">
      <ul className="space-y-1">
        {items.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-sm">
            <span className="flex-1">{c.title}{c.ownerId && <span className="ml-1 text-xs text-[var(--muted-foreground)]">(personal)</span>}</span>
            <button type="button" className="text-xs" onClick={() => startEdit(c)}>Edit</button>
            <button type="button" className="text-xs text-red-600" onClick={() => void apiFetch(`/helpdesk/canned-responses/${c.id}`, { method: "DELETE" }).then(load)}>Delete</button>
          </li>
        ))}
      </ul>
      <div className="border border-[var(--border)] rounded-lg p-4 space-y-2">
        <h3 className="text-sm font-medium">{editing ? `Edit "${editing.title}"` : "New response"}</h3>
        <input aria-label="Response title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Title" className={inputClass} />
        <textarea aria-label="Response body" value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={50000} placeholder="Body (markdown)" className={inputClass} />
        <p className="text-xs text-[var(--muted-foreground)]">Variables: {CANNED_RESPONSE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} /> Only for me</label>
        <div className="flex gap-2">
          <button type="button" className={primaryButton} disabled={!title.trim() || !body.trim()} onClick={() => void save()}>Save response</button>
          {editing && <button type="button" className={buttonClass} onClick={() => startEdit(null)}>Cancel</button>}
        </div>
      </div>
    </Section>
  );
}
