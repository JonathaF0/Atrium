"use client";

import { useCallback, useEffect, useState } from "react";
import { TICKET_PRIORITIES } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session-context";
import { useToast } from "@/components/toast";
import { priorityLabel } from "@/lib/tickets";
import { Section, buttonClass, inputClass, primaryButton, smallInput, type Calendar, type Category, type SlaPolicy, type Staff } from "./shared";
import { BusinessHoursSection, SlaSection } from "./sla-section";
import { CannedSection, RulesSection } from "./rules-section";

interface HelpdeskSettings {
  ticketPrefix: string;
  nextTicketNumber: number;
  autoAcknowledge: boolean;
  csatEnabled: boolean;
  clientsCanClose: boolean;
  closeResolvedAfterDays: number;
  closeWaitingAfterDays: number;
  triageAssigneeId: string | null;
  defaultSlaPolicyId: string | null;
  inbound: {
    mode: string;
    address: string | null;
    webhookUrl: string | null;
    hasWebhookSecret: boolean;
    imapHost: string | null;
    imapPort: number | null;
    imapUser: string | null;
    hasImapPassword: boolean;
    imapSecure: boolean;
    imapMailbox: string;
    imapLastPolledAt: string | null;
    imapLastError: string | null;
  };
}

export default function HelpdeskSettingsPage(): React.ReactElement {
  const [settings, setSettings] = useState<HelpdeskSettings | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [policies, setPolicies] = useState<SlaPolicy[]>([]);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, st, c, p, cal] = await Promise.all([
        apiFetch<HelpdeskSettings>("/helpdesk/settings"),
        apiFetch<Staff[]>("/helpdesk/staff"),
        apiFetch<Category[]>("/helpdesk/categories"),
        apiFetch<SlaPolicy[]>("/helpdesk/sla-policies"),
        apiFetch<Calendar[]>("/helpdesk/business-hours"),
      ]);
      setSettings(s);
      setStaff(st);
      setCategories(c);
      setPolicies(p);
      setCalendars(cal);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load helpdesk settings");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="p-4 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>;
  if (!settings) return <div className="text-sm text-[var(--muted-foreground)]">Loading...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <GeneralSection settings={settings} staff={staff} policies={policies} onSaved={load} />
      <CategoriesSection categories={categories} policies={policies} staff={staff} onChange={load} />
      <SlaSection policies={policies} calendars={calendars} staff={staff} onChange={load} />
      <BusinessHoursSection calendars={calendars} onChange={load} />
      <CannedSection />
      <RulesSection categories={categories.filter((c) => !c.archivedAt)} staff={staff} />
      <InboundSection settings={settings} onSaved={load} />
    </div>
  );
}

function GeneralSection({ settings, staff, policies, onSaved }: { settings: HelpdeskSettings; staff: Staff[]; policies: SlaPolicy[]; onSaved: () => Promise<void> }): React.ReactElement {
  const toast = useToast();
  const [form, setForm] = useState({
    ticketPrefix: settings.ticketPrefix,
    autoAcknowledge: settings.autoAcknowledge,
    csatEnabled: settings.csatEnabled,
    clientsCanClose: settings.clientsCanClose,
    closeResolvedAfterDays: String(settings.closeResolvedAfterDays),
    closeWaitingAfterDays: String(settings.closeWaitingAfterDays),
    triageAssigneeId: settings.triageAssigneeId ?? "",
    defaultSlaPolicyId: settings.defaultSlaPolicyId ?? "",
  });
  const save = async (): Promise<void> => {
    try {
      await apiFetch("/helpdesk/settings", {
        method: "PATCH",
        body: JSON.stringify({
          ...form,
          closeResolvedAfterDays: Number(form.closeResolvedAfterDays),
          closeWaitingAfterDays: Number(form.closeWaitingAfterDays),
          triageAssigneeId: form.triageAssigneeId || null,
          defaultSlaPolicyId: form.defaultSlaPolicyId || null,
        }),
      });
      toast.success("Helpdesk settings saved");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };
  const toggle = (k: "autoAcknowledge" | "csatEnabled" | "clientsCanClose", label: string): React.ReactElement => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
      {label}
    </label>
  );
  return (
    <Section title="Helpdesk" description="How tickets are numbered and what clients can do.">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-sm">
          Ticket prefix
          <input value={form.ticketPrefix} onChange={(e) => setForm({ ...form, ticketPrefix: e.target.value.toUpperCase() })} maxLength={10} className={inputClass} />
          <span className="text-xs text-[var(--muted-foreground)]">Next ticket: {form.ticketPrefix}-{settings.nextTicketNumber}</span>
        </label>
        <label className="text-sm">
          Default SLA policy
          <select value={form.defaultSlaPolicyId} onChange={(e) => setForm({ ...form, defaultSlaPolicyId: e.target.value })} className={inputClass}>
            <option value="">No SLA</option>
            {policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          Close resolved tickets after (days, 0 = never)
          <input type="number" min={0} max={365} value={form.closeResolvedAfterDays} onChange={(e) => setForm({ ...form, closeResolvedAfterDays: e.target.value })} className={inputClass} />
        </label>
        <label className="text-sm">
          Close tickets waiting on the client after (days, 0 = never)
          <input type="number" min={0} max={365} value={form.closeWaitingAfterDays} onChange={(e) => setForm({ ...form, closeWaitingAfterDays: e.target.value })} className={inputClass} />
        </label>
        <label className="text-sm">
          Assign triage tickets to
          <select value={form.triageAssigneeId} onChange={(e) => setForm({ ...form, triageAssigneeId: e.target.value })} className={inputClass}>
            <option value="">Nobody</option>
            {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
          </select>
        </label>
      </div>
      <div className="space-y-1">
        {toggle("autoAcknowledge", "Email an acknowledgement when a client opens a ticket")}
        {toggle("csatEnabled", "Ask clients to rate resolved tickets")}
        {toggle("clientsCanClose", "Let clients close their own tickets")}
      </div>
      <button type="button" onClick={() => void save()} className={primaryButton}>Save</button>
    </Section>
  );
}

function CategoryRow({ category, policies, staff, onChange }: { category: Category; policies: SlaPolicy[]; staff: Staff[]; onChange: () => Promise<void> }): React.ReactElement {
  const toast = useToast();
  const patch = async (data: Record<string, unknown>): Promise<void> => {
    try {
      await apiFetch(`/helpdesk/categories/${category.id}`, { method: "PATCH", body: JSON.stringify(data) });
      await onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };
  return (
    <tr className={`border-t border-[var(--border)] ${category.archivedAt ? "opacity-50" : ""}`}>
      <td className="py-2 pr-2">
        <span className="inline-block w-2.5 h-2.5 rounded-full mr-2" style={{ backgroundColor: category.color }} />
        {category.name}
        <span className="ml-1 text-xs text-[var(--muted-foreground)]">({category._count?.tickets ?? 0})</span>
      </td>
      <td className="pr-2">
        <select aria-label={`${category.name} default priority`} value={category.defaultPriority} onChange={(e) => void patch({ defaultPriority: e.target.value })} className={smallInput}>
          {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
        </select>
      </td>
      <td className="pr-2">
        <select aria-label={`${category.name} SLA`} value={category.slaPolicyId ?? ""} onChange={(e) => void patch({ slaPolicyId: e.target.value || null })} className={smallInput}>
          <option value="">Workspace default</option>
          {policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </td>
      <td className="pr-2">
        <select aria-label={`${category.name} assignee`} value={category.defaultAssigneeId ?? ""} onChange={(e) => void patch({ defaultAssigneeId: e.target.value || null })} className={smallInput}>
          <option value="">Nobody</option>
          {staff.map((s) => <option key={s.userId} value={s.userId}>{s.name}</option>)}
        </select>
      </td>
      <td className="pr-2 text-center">
        <input type="checkbox" aria-label={`${category.name} visible in portal`} checked={category.portalVisible} onChange={(e) => void patch({ portalVisible: e.target.checked })} />
      </td>
      <td>
        <button type="button" className="text-xs" onClick={() => void patch({ archived: !category.archivedAt })}>{category.archivedAt ? "Restore" : "Archive"}</button>
      </td>
    </tr>
  );
}

function CategoriesSection({ categories, policies, staff, onChange }: { categories: Category[]; policies: SlaPolicy[]; staff: Staff[]; onChange: () => Promise<void> }): React.ReactElement {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const add = async (): Promise<void> => {
    try {
      await apiFetch("/helpdesk/categories", { method: "POST", body: JSON.stringify({ name, description: description || undefined, order: categories.length }) });
      setName("");
      setDescription("");
      await onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the category");
    }
  };
  return (
    <Section title="Categories" description="What clients choose when they open a ticket. Archived categories stay on old tickets.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-[var(--muted-foreground)] text-left">
            <tr><th className="py-1">Name</th><th>Default priority</th><th>SLA policy</th><th>Default assignee</th><th>Portal</th><th /></tr>
          </thead>
          <tbody>
            {categories.map((c) => <CategoryRow key={c.id} category={c} policies={policies} staff={staff} onChange={onChange} />)}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <input aria-label="New category name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="New category" className={smallInput} />
        <input aria-label="New category description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Description (optional)" className={smallInput + " flex-1 min-w-[200px]"} />
        <button type="button" disabled={!name.trim()} onClick={() => void add()} className={buttonClass}>Add category</button>
      </div>
    </Section>
  );
}

function InboundSection({ settings, onSaved }: { settings: HelpdeskSettings; onSaved: () => Promise<void> }): React.ReactElement {
  const toast = useToast();
  const { role } = useSession();
  const inbound = settings.inbound;
  const [form, setForm] = useState({
    inboundMode: inbound.mode,
    inboundAddress: inbound.address ?? "",
    imapHost: inbound.imapHost ?? "",
    imapPort: inbound.imapPort ? String(inbound.imapPort) : "",
    imapUser: inbound.imapUser ?? "",
    imapPass: "",
    imapSecure: inbound.imapSecure,
    imapMailbox: inbound.imapMailbox,
  });
  const [secret, setSecret] = useState("");
  const [testResult, setTestResult] = useState("");

  const save = async (): Promise<void> => {
    try {
      await apiFetch("/helpdesk/inbound", {
        method: "PATCH",
        body: JSON.stringify({
          inboundMode: form.inboundMode,
          inboundAddress: form.inboundAddress.trim() || null,
          ...(form.inboundMode === "imap"
            ? {
                imapHost: form.imapHost.trim() || null,
                imapPort: form.imapPort ? Number(form.imapPort) : null,
                imapUser: form.imapUser.trim() || null,
                imapSecure: form.imapSecure,
                imapMailbox: form.imapMailbox || "INBOX",
                ...(form.imapPass ? { imapPass: form.imapPass } : {}),
              }
            : {}),
        }),
      });
      setForm({ ...form, imapPass: "" });
      toast.success("Inbound email saved");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };

  return (
    <Section title="Inbound email" description="Turn emails to your support address into tickets. Replies thread into existing tickets; unknown senders go to triage.">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-sm">
          Mode
          <select value={form.inboundMode} onChange={(e) => setForm({ ...form, inboundMode: e.target.value })} className={inputClass}>
            <option value="none">Off</option>
            <option value="webhook">Signed webhook</option>
            <option value="imap">IMAP mailbox</option>
          </select>
        </label>
        <label className="text-sm">
          Support address
          <input type="email" value={form.inboundAddress} onChange={(e) => setForm({ ...form, inboundAddress: e.target.value })} maxLength={320} placeholder="support@example.com" className={inputClass} />
          <span className="text-xs text-[var(--muted-foreground)]">Used as Reply-To on ticket emails.</span>
        </label>
      </div>

      {form.inboundMode === "webhook" && (
        <div className="space-y-2 text-sm">
          <div>
            <div className="text-xs text-[var(--muted-foreground)]">Webhook URL</div>
            <code className="block p-2 bg-[var(--muted)] rounded break-all text-xs">{inbound.webhookUrl ?? "Set a workspace URL slug first"}</code>
          </div>
          <p className="text-xs text-[var(--muted-foreground)]">
            POST JSON (from, to, subject, text, messageId, inReplyTo, references, headers, attachments[{"{"}filename, contentType, content (base64){"}"}], or raw: base64 RFC 822) with headers
            X-Atrium-Timestamp (unix seconds) and X-Atrium-Signature: sha256=HMAC-SHA256(secret, timestamp + &quot;.&quot; + body).
          </p>
          <p className="text-xs">{inbound.hasWebhookSecret ? "A signing secret is set." : "No signing secret yet."}</p>
          {secret && (
            <div className="p-2 bg-amber-50 dark:bg-amber-950/30 rounded text-xs">
              Copy this secret now; it is not shown again:
              <code className="block break-all mt-1" data-testid="inbound-secret">{secret}</code>
            </div>
          )}
          {role === "owner" && (
            <button
              type="button"
              className={buttonClass}
              onClick={async () => {
                try {
                  const res = await apiFetch<{ secret: string }>("/helpdesk/inbound/secret", { method: "POST" });
                  setSecret(res.secret);
                  await onSaved();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Could not rotate the secret");
                }
              }}
            >
              {inbound.hasWebhookSecret ? "Rotate secret" : "Generate secret"}
            </button>
          )}
        </div>
      )}

      {form.inboundMode === "imap" && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-sm">Host<input value={form.imapHost} onChange={(e) => setForm({ ...form, imapHost: e.target.value })} maxLength={255} className={inputClass} placeholder="imap.example.com" /></label>
            <label className="text-sm">Port<input type="number" value={form.imapPort} onChange={(e) => setForm({ ...form, imapPort: e.target.value })} className={inputClass} placeholder="993" /></label>
            <label className="text-sm">Mailbox<input value={form.imapMailbox} onChange={(e) => setForm({ ...form, imapMailbox: e.target.value })} maxLength={200} className={inputClass} /></label>
            <label className="text-sm">User<input value={form.imapUser} onChange={(e) => setForm({ ...form, imapUser: e.target.value })} maxLength={320} className={inputClass} /></label>
            <label className="text-sm">Password<input type="password" value={form.imapPass} onChange={(e) => setForm({ ...form, imapPass: e.target.value })} maxLength={500} className={inputClass} placeholder={inbound.hasImapPassword ? "Saved (leave blank to keep)" : ""} /></label>
            <label className="flex items-center gap-2 text-sm mt-5"><input type="checkbox" checked={form.imapSecure} onChange={(e) => setForm({ ...form, imapSecure: e.target.checked })} /> TLS</label>
          </div>
          <p className="text-xs text-[var(--muted-foreground)]">
            Polled every minute; only new messages are imported. {inbound.imapLastPolledAt && `Last checked ${new Date(inbound.imapLastPolledAt).toLocaleString()}.`}
            {inbound.imapLastError && <span className="text-red-600"> Last error: {inbound.imapLastError}</span>}
          </p>
          <button
            type="button"
            className={buttonClass}
            onClick={async () => {
              setTestResult("Testing...");
              try {
                const res = await apiFetch<{ ok: boolean; error?: string; messages?: number }>("/helpdesk/inbound/test-imap", { method: "POST" });
                setTestResult(res.ok ? `Connected (${res.messages ?? 0} messages in mailbox)` : `Failed: ${res.error}`);
              } catch (err) {
                setTestResult(err instanceof Error ? err.message : "Test failed");
              }
            }}
          >
            Test saved connection
          </button>
          {testResult && <p className="text-xs">{testResult}</p>}
        </div>
      )}
      <button type="button" onClick={() => void save()} className={primaryButton}>Save inbound settings</button>
    </Section>
  );
}
