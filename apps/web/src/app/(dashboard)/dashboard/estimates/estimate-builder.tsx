"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Eye, Layers, Package, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { computeEstimateTotals, type BillingType } from "@atrium/shared";
import { apiFetch } from "@/lib/api";
import { useCurrency } from "@/lib/app-config";
import { currencySymbol, formatCurrency } from "@/lib/format";
import { useToast } from "@/components/toast";
import { TaxRateSelect } from "@/components/tax-rate-select";
import { EstimateDocument } from "@/components/estimate-document";
import { useDebounce } from "@/hooks/use-debounce";
import { BILLING_TYPE_LABELS, INTERVAL_LABELS, centsToInput, parseMoneyInput, parseQuantity } from "@/lib/estimates";

export interface BuilderLine {
  key: string;
  catalogItemId: string | null;
  group: string;
  name: string;
  description: string;
  unit: string;
  billingType: string;
  recurringInterval: string;
  quantity: string;
  unitPrice: string;
  costCents: number | null;
  taxable: boolean;
  taxRateBps: number;
  optional: boolean;
  selected: boolean;
}

export interface BuilderForm {
  title: string;
  introduction: string;
  companyId: string;
  recipientUserId: string;
  projectId: string;
  ticketId: string;
  discountType: string;
  discountValue: string;
  depositPercent: string;
  assumptions: string;
  exclusions: string;
  terms: string;
  validUntil: string;
  aiDrafted: boolean;
  lines: BuilderLine[];
}

interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  unit: string;
  billingType: string;
  recurringInterval: string | null;
  rateCents: number;
  costCents: number | null;
  taxable: boolean;
}

interface Bundle {
  id: string;
  name: string;
  items: Array<{ quantity: number; optional: boolean; catalogItem: CatalogItem }>;
}

interface ClientsResponse {
  companies: Array<{ id: string; name: string }>;
  recipients: Array<{ userId: string; name: string; email: string; companyId: string | null }>;
}

interface AiSuggestion {
  title: string;
  introduction: string;
  assumptions: string;
  exclusions: string;
  lineItems: Array<{
    catalogItemId: string | null;
    group: string | null;
    name: string;
    description: string | null;
    unit: string;
    billingType: string;
    recurringInterval: string | null;
    quantity: number;
    unitPriceCents: number;
    costCents: number | null;
    taxable: boolean;
    optional: boolean;
    fromCatalog: boolean;
  }>;
}

const inputClass =
  "w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm outline-none focus:ring-1 focus:ring-[var(--primary)]";
const smallInput = "px-2 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";

let keySeq = 0;
export function newKey(): string {
  keySeq += 1;
  return `l${Date.now().toString(36)}${keySeq}`;
}

export function emptyLine(defaultTax: number): BuilderLine {
  return {
    key: newKey(),
    catalogItemId: null,
    group: "",
    name: "",
    description: "",
    unit: "",
    billingType: "fixed",
    recurringInterval: "monthly",
    quantity: "1",
    unitPrice: "",
    costCents: null,
    taxable: true,
    taxRateBps: defaultTax,
    optional: false,
    selected: true,
  };
}

function lineFromCatalog(item: CatalogItem, defaultTax: number, extra: Partial<BuilderLine> = {}): BuilderLine {
  return {
    key: newKey(),
    catalogItemId: item.id,
    group: "",
    name: item.name,
    description: item.description ?? "",
    unit: item.unit,
    billingType: item.billingType,
    recurringInterval: item.recurringInterval ?? "monthly",
    quantity: "1",
    unitPrice: centsToInput(item.rateCents),
    costCents: item.costCents,
    taxable: item.taxable,
    taxRateBps: item.taxable ? defaultTax : 0,
    optional: false,
    selected: true,
    ...extra,
  };
}

/** The builder's form as the API payload. */
export function toPayload(form: BuilderForm) {
  return {
    title: form.title.trim(),
    introduction: form.introduction.trim() || null,
    companyId: form.companyId || null,
    recipientUserId: form.recipientUserId || null,
    projectId: form.projectId || null,
    ticketId: form.ticketId || null,
    discountType: form.discountType || null,
    discountValue: form.discountType
      ? form.discountType === "percent"
        ? Math.round((Number(form.discountValue.replace(",", ".")) || 0) * 100)
        : parseMoneyInput(form.discountValue)
      : null,
    depositPercent: form.depositPercent ? Math.min(100, Math.max(0, parseInt(form.depositPercent, 10) || 0)) : null,
    assumptions: form.assumptions.trim() || null,
    exclusions: form.exclusions.trim() || null,
    terms: form.terms.trim() || null,
    validUntil: form.validUntil ? new Date(`${form.validUntil}T23:59:59`).toISOString() : null,
    aiDrafted: form.aiDrafted,
    lineItems: form.lines
      .filter((l) => l.name.trim())
      .map((l) => ({
        catalogItemId: l.catalogItemId,
        group: l.group.trim() || null,
        name: l.name.trim(),
        description: l.description.trim() || null,
        unit: l.unit.trim() || undefined,
        billingType: l.billingType,
        recurringInterval: l.billingType === "recurring" ? l.recurringInterval : null,
        quantity: parseQuantity(l.quantity) || 1,
        unitPriceCents: parseMoneyInput(l.unitPrice),
        costCents: l.costCents,
        taxable: l.taxable,
        taxRateBps: l.taxable ? l.taxRateBps : 0,
        optional: l.optional,
        selected: l.optional ? l.selected : true,
      })),
  };
}

function CatalogPicker({ onAdd, onAddBundle }: { onAdd: (item: CatalogItem) => void; onAddBundle: (b: Bundle) => void }) {
  const [tab, setTab] = useState<"items" | "bundles">("items");
  const [search, setSearch] = useState("");
  const debounced = useDebounce(search, 250);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [bundles, setBundles] = useState<Bundle[]>([]);

  useEffect(() => {
    const params = new URLSearchParams({ limit: "30" });
    if (debounced) params.set("search", debounced);
    if (tab === "items") {
      apiFetch<{ data: CatalogItem[] }>(`/catalog/items?${params}`).then((r) => setItems(r.data)).catch(() => setItems([]));
    } else {
      apiFetch<Bundle[]>(`/catalog/bundles?${params}`).then(setBundles).catch(() => setBundles([]));
    }
  }, [debounced, tab]);

  return (
    <div className="border border-[var(--border)] rounded-xl p-3 space-y-2" data-testid="catalog-picker">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setTab("items")}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${tab === "items" ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
        >
          <Package size={12} /> Items
        </button>
        <button
          type="button"
          onClick={() => setTab("bundles")}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${tab === "bundles" ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
        >
          <Layers size={12} /> Bundles
        </button>
        <input
          aria-label="Search catalog"
          placeholder="Search catalog..."
          value={search}
          maxLength={200}
          onChange={(e) => setSearch(e.target.value)}
          className={`${smallInput} flex-1`}
        />
      </div>
      <ul className="max-h-56 overflow-y-auto divide-y divide-[var(--border)] text-sm">
        {tab === "items" &&
          items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                {i.name}
                <span className="ml-1 text-xs text-[var(--muted-foreground)]">
                  {BILLING_TYPE_LABELS[i.billingType]} · {centsToInput(i.rateCents)}
                </span>
              </span>
              <button type="button" onClick={() => onAdd(i)} aria-label={`Add ${i.name}`} className="text-xs text-[var(--primary)] hover:underline">
                Add
              </button>
            </li>
          ))}
        {tab === "bundles" &&
          bundles.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                {b.name} <span className="text-xs text-[var(--muted-foreground)]">({b.items.length} items)</span>
              </span>
              <button type="button" onClick={() => onAddBundle(b)} aria-label={`Insert bundle ${b.name}`} className="text-xs text-[var(--primary)] hover:underline">
                Insert
              </button>
            </li>
          ))}
        {((tab === "items" && items.length === 0) || (tab === "bundles" && bundles.length === 0)) && (
          <li className="py-2 text-xs text-[var(--muted-foreground)]">Nothing found.</li>
        )}
      </ul>
    </div>
  );
}

function AiAssist({ ticketId, onSuggestion }: { ticketId: string; onSuggestion: (s: AiSuggestion) => void }) {
  const { error: showError } = useToast();
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch<{ available: boolean }>("/estimates/ai-draft/status")
      .then((s) => setAvailable(s.available))
      .catch(() => setAvailable(false));
  }, []);

  if (!available) return null;
  return (
    <div className="border border-dashed border-[var(--border)] rounded-xl p-3 space-y-2">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2 text-sm font-medium">
        <Sparkles size={14} className="text-[var(--primary)]" /> Draft with AI
      </button>
      {open && (
        <>
          <textarea
            aria-label="Describe the work"
            rows={4}
            maxLength={10000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={ticketId ? "Optional notes; the linked ticket's public messages are used too." : "Describe what the client needs..."}
            className={inputClass}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading || (!text.trim() && !ticketId)}
              onClick={async () => {
                setLoading(true);
                try {
                  const s = await apiFetch<AiSuggestion>("/estimates/ai-draft", {
                    method: "POST",
                    body: JSON.stringify({ text: text.trim() || undefined, ticketId: ticketId || undefined }),
                  });
                  onSuggestion(s);
                } catch (err) {
                  showError(err instanceof Error ? err.message : "AI draft failed");
                } finally {
                  setLoading(false);
                }
              }}
              className="px-3 py-1.5 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-50"
            >
              {loading ? "Drafting..." : "Suggest a draft"}
            </button>
            <span className="text-xs text-[var(--muted-foreground)]">Nothing is saved or sent until you review it.</span>
          </div>
        </>
      )}
    </div>
  );
}

export function EstimateBuilder({
  initial,
  estimateId,
  defaultTax,
  onSaved,
}: {
  initial: BuilderForm;
  estimateId?: string;
  defaultTax: number;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const currency = useCurrency();
  const { success, error: showError } = useToast();
  const [form, setForm] = useState<BuilderForm>(initial);
  const [clients, setClients] = useState<ClientsResponse>({ companies: [], recipients: [] });
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [suggestion, setSuggestion] = useState<AiSuggestion | null>(null);
  const [editingLine, setEditingLine] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ClientsResponse>("/estimates/clients").then(setClients).catch(() => undefined);
    apiFetch<{ data: Array<{ id: string; name: string }> }>("/projects?limit=100")
      .then((r) => setProjects(r.data))
      .catch(() => undefined);
  }, []);

  const set = <K extends keyof BuilderForm>(k: K, v: BuilderForm[K]): void => setForm((f) => ({ ...f, [k]: v }));
  const setLine = (key: string, patch: Partial<BuilderLine>): void =>
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const moveLine = (index: number, delta: number): void =>
    setForm((f) => {
      const lines = [...f.lines];
      const target = index + delta;
      if (target < 0 || target >= lines.length) return f;
      [lines[index], lines[target]] = [lines[target], lines[index]];
      return { ...f, lines };
    });

  const payload = useMemo(() => toPayload(form), [form]);
  const totals = useMemo(
    () =>
      computeEstimateTotals(
        payload.lineItems.map((l) => ({
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          taxRateBps: l.taxRateBps,
          taxable: l.taxable,
          optional: l.optional,
          selected: l.selected,
          billingType: l.billingType as BillingType,
        })),
        { type: (payload.discountType as "percent" | "amount" | null) ?? null, value: payload.discountValue },
        payload.depositPercent,
      ),
    [payload],
  );
  const recurring = useMemo(() => {
    const out: Record<string, number> = {};
    for (const l of payload.lineItems) {
      if (l.billingType !== "recurring" || (l.optional && !l.selected)) continue;
      const k = l.recurringInterval || "monthly";
      out[k] = (out[k] ?? 0) + Math.round(l.quantity * l.unitPriceCents);
    }
    return out;
  }, [payload]);
  const margin = useMemo(() => {
    const oneTime = payload.lineItems.filter((l) => l.billingType !== "recurring" && (!l.optional || l.selected));
    const cost = oneTime.reduce((s, l) => s + Math.round(l.quantity * (l.costCents ?? 0)), 0);
    const price = totals.oneTimeSubtotalCents - totals.discountCents;
    return { cost, price, margin: price - cost, pct: price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : null };
  }, [payload, totals]);

  const recipients = form.companyId ? clients.recipients.filter((r) => r.companyId === form.companyId) : clients.recipients;

  async function save(): Promise<void> {
    if (!payload.title) {
      showError("Give the estimate a title");
      return;
    }
    setSaving(true);
    try {
      if (estimateId) {
        await apiFetch(`/estimates/${estimateId}`, { method: "PUT", body: JSON.stringify(payload) });
        success("Estimate saved");
        onSaved?.();
      } else {
        const created = await apiFetch<{ id: string }>("/estimates", { method: "POST", body: JSON.stringify(payload) });
        success("Estimate created");
        router.push(`/dashboard/estimates/${created.id}`);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save estimate");
    } finally {
      setSaving(false);
    }
  }

  function applySuggestion(s: AiSuggestion): void {
    setForm((f) => ({
      ...f,
      title: f.title || s.title,
      introduction: s.introduction,
      assumptions: s.assumptions,
      exclusions: s.exclusions,
      aiDrafted: true,
      lines: [
        ...f.lines.filter((l) => l.name.trim()),
        ...s.lineItems.map((l) => ({
          key: newKey(),
          catalogItemId: l.catalogItemId,
          group: l.group ?? "",
          name: l.name,
          description: l.description ?? "",
          unit: l.unit,
          billingType: l.billingType,
          recurringInterval: l.recurringInterval ?? "monthly",
          quantity: String(l.quantity),
          unitPrice: centsToInput(l.unitPriceCents),
          costCents: l.costCents,
          taxable: l.taxable,
          taxRateBps: l.taxable ? defaultTax : 0,
          optional: l.optional,
          selected: true,
        })),
      ],
    }));
    setSuggestion(null);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-5 min-w-0">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPreview(false)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm ${!preview ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
          >
            <Pencil size={14} /> Edit
          </button>
          <button
            type="button"
            onClick={() => setPreview(true)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm ${preview ? "bg-[var(--muted)] font-medium" : "text-[var(--muted-foreground)]"}`}
          >
            <Eye size={14} /> Preview
          </button>
        </div>

        {preview ? (
          <div className="border border-[var(--border)] rounded-xl p-5">
            <EstimateDocument
              currency={currency}
              estimate={{
                ...payload,
                title: payload.title || "Untitled estimate",
                validUntil: payload.validUntil,
                lineItems: payload.lineItems.map((l) => ({
                  ...l,
                  group: l.group,
                  description: l.description,
                  unit: l.unit ?? (l.billingType === "hourly" ? "hour" : "each"),
                  recurringInterval: l.recurringInterval,
                })),
                totals,
                recurring,
              }}
            />
          </div>
        ) : (
          <>
            <AiAssist ticketId={form.ticketId} onSuggestion={setSuggestion} />
            {suggestion && (
              <div className="border border-[var(--primary)] rounded-xl p-4 space-y-2" data-testid="ai-suggestion">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Sparkles size={14} /> Suggested draft: {suggestion.title}
                </p>
                <ul className="text-sm list-disc pl-5">
                  {suggestion.lineItems.map((l, i) => (
                    <li key={i}>
                      {l.quantity} × {l.name} {l.fromCatalog ? "" : <span className="text-xs text-amber-600">(not in catalog, check the price)</span>}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <button type="button" onClick={() => applySuggestion(suggestion)} className="px-3 py-1.5 bg-[var(--primary)] text-white rounded-lg text-sm">
                    Use suggestion
                  </button>
                  <button type="button" onClick={() => setSuggestion(null)} className="px-3 py-1.5 border border-[var(--border)] rounded-lg text-sm">
                    Discard
                  </button>
                </div>
              </div>
            )}

            <label className="block text-sm">
              <span className="text-[var(--muted-foreground)]">Title</span>
              <input aria-label="Estimate title" required maxLength={200} value={form.title} onChange={(e) => set("title", e.target.value)} className={inputClass} />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="text-[var(--muted-foreground)]">Company</span>
                <select
                  aria-label="Company"
                  value={form.companyId}
                  onChange={(e) => {
                    const companyId = e.target.value;
                    const keep = clients.recipients.find((r) => r.userId === form.recipientUserId && (!companyId || r.companyId === companyId));
                    setForm((f) => ({ ...f, companyId, recipientUserId: keep ? f.recipientUserId : "" }));
                  }}
                  className={inputClass}
                >
                  <option value="">No company</option>
                  {clients.companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="text-[var(--muted-foreground)]">Recipient (portal client)</span>
                <select
                  aria-label="Recipient"
                  value={form.recipientUserId}
                  onChange={(e) => {
                    const r = clients.recipients.find((x) => x.userId === e.target.value);
                    setForm((f) => ({ ...f, recipientUserId: e.target.value, companyId: r?.companyId ?? f.companyId }));
                  }}
                  className={inputClass}
                >
                  <option value="">Choose a recipient...</option>
                  {recipients.map((r) => (
                    <option key={r.userId} value={r.userId}>{r.name} ({r.email})</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="text-[var(--muted-foreground)]">Project (optional)</span>
                <select aria-label="Project" value={form.projectId} onChange={(e) => set("projectId", e.target.value)} className={inputClass}>
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="text-[var(--muted-foreground)]">Valid until</span>
                <input aria-label="Valid until" type="date" value={form.validUntil} onChange={(e) => set("validUntil", e.target.value)} className={inputClass} />
              </label>
            </div>

            <label className="block text-sm">
              <span className="text-[var(--muted-foreground)]">Introduction / scope (markdown)</span>
              <textarea aria-label="Introduction" rows={4} maxLength={20000} value={form.introduction} onChange={(e) => set("introduction", e.target.value)} className={inputClass} />
            </label>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Line items</h3>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine(defaultTax)] }))}
                  className="flex items-center gap-1 text-sm text-[var(--primary)] hover:underline"
                >
                  <Plus size={14} /> Custom line
                </button>
              </div>
              <CatalogPicker
                onAdd={(item) => setForm((f) => ({ ...f, lines: [...f.lines.filter((l) => l.name.trim()), lineFromCatalog(item, defaultTax)] }))}
                onAddBundle={(b) =>
                  setForm((f) => ({
                    ...f,
                    lines: [
                      ...f.lines.filter((l) => l.name.trim()),
                      ...b.items.map((bi) =>
                        lineFromCatalog(bi.catalogItem, defaultTax, { group: b.name, quantity: String(bi.quantity), optional: bi.optional }),
                      ),
                    ],
                  }))
                }
              />
              <div className="space-y-2">
                {form.lines.map((l, i) => (
                  <div key={l.key} data-testid="builder-line" className="border border-[var(--border)] rounded-xl p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        aria-label="Line name"
                        placeholder="Item name"
                        maxLength={200}
                        value={l.name}
                        onChange={(e) => setLine(l.key, { name: e.target.value })}
                        className={`${smallInput} flex-1 min-w-[10rem]`}
                      />
                      <input
                        aria-label="Quantity"
                        inputMode="decimal"
                        value={l.quantity}
                        onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                        className={`${smallInput} w-20`}
                      />
                      <div className="relative w-28">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[var(--muted-foreground)]">{currencySymbol(currency)}</span>
                        <input
                          aria-label="Unit price"
                          inputMode="decimal"
                          placeholder="0.00"
                          value={l.unitPrice}
                          onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                          className={`${smallInput} w-full pl-6`}
                        />
                      </div>
                      <span className="w-24 text-right text-sm font-medium">
                        {formatCurrency(Math.round((parseQuantity(l.quantity) || 0) * parseMoneyInput(l.unitPrice)), currency)}
                      </span>
                      <div className="flex text-[var(--muted-foreground)]">
                        <button type="button" aria-label="Line details" onClick={() => setEditingLine(editingLine === l.key ? null : l.key)} className="p-1"><Pencil size={14} /></button>
                        <button type="button" aria-label="Move line up" onClick={() => moveLine(i, -1)} className="p-1"><ArrowUp size={14} /></button>
                        <button type="button" aria-label="Move line down" onClick={() => moveLine(i, 1)} className="p-1"><ArrowDown size={14} /></button>
                        <button
                          type="button"
                          aria-label="Remove line"
                          onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((x) => x.key !== l.key) }))}
                          className="p-1 hover:text-red-600"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--muted-foreground)]">
                      {l.group && <span className="px-1.5 py-0.5 rounded bg-[var(--muted)]">{l.group}</span>}
                      <select aria-label="Billing type" value={l.billingType} onChange={(e) => setLine(l.key, { billingType: e.target.value })} className={smallInput}>
                        {Object.entries(BILLING_TYPE_LABELS).map(([v, label]) => (
                          <option key={v} value={v}>{label}</option>
                        ))}
                      </select>
                      {l.billingType === "recurring" && (
                        <select aria-label="Interval" value={l.recurringInterval} onChange={(e) => setLine(l.key, { recurringInterval: e.target.value })} className={smallInput}>
                          {Object.entries(INTERVAL_LABELS).map(([v, label]) => (
                            <option key={v} value={v}>{label}</option>
                          ))}
                        </select>
                      )}
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={l.taxable} onChange={(e) => setLine(l.key, { taxable: e.target.checked, taxRateBps: e.target.checked ? l.taxRateBps || defaultTax : 0 })} />
                        Taxable
                      </label>
                      {l.taxable && <TaxRateSelect value={l.taxRateBps} onChange={(bps) => setLine(l.key, { taxRateBps: bps })} className={smallInput} />}
                      <label className="flex items-center gap-1">
                        <input type="checkbox" aria-label="Optional item" checked={l.optional} onChange={(e) => setLine(l.key, { optional: e.target.checked })} />
                        Optional
                      </label>
                      {l.optional && (
                        <label className="flex items-center gap-1">
                          <input type="checkbox" checked={l.selected} onChange={(e) => setLine(l.key, { selected: e.target.checked })} />
                          Selected by default
                        </label>
                      )}
                      {l.costCents != null && <span>Cost {formatCurrency(l.costCents, currency)}</span>}
                    </div>
                    {editingLine === l.key && (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <input aria-label="Line description" placeholder="Description" maxLength={5000} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} className={`${smallInput} sm:col-span-3`} />
                        <input aria-label="Section" placeholder="Section heading" maxLength={200} value={l.group} onChange={(e) => setLine(l.key, { group: e.target.value })} className={smallInput} />
                        <input aria-label="Unit" placeholder={l.billingType === "hourly" ? "hour" : "each"} maxLength={30} value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} className={smallInput} />
                        <input
                          aria-label="Cost (internal)"
                          placeholder="Cost (internal)"
                          inputMode="decimal"
                          value={centsToInput(l.costCents)}
                          onChange={(e) => setLine(l.key, { costCents: e.target.value.trim() ? parseMoneyInput(e.target.value) : null })}
                          className={smallInput}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm">
                <span className="text-[var(--muted-foreground)]">Discount</span>
                <select aria-label="Discount type" value={form.discountType} onChange={(e) => set("discountType", e.target.value)} className={inputClass}>
                  <option value="">None</option>
                  <option value="percent">Percent</option>
                  <option value="amount">Amount</option>
                </select>
              </label>
              {form.discountType && (
                <label className="text-sm">
                  <span className="text-[var(--muted-foreground)]">{form.discountType === "percent" ? "Discount %" : "Discount amount"}</span>
                  <input aria-label="Discount value" inputMode="decimal" value={form.discountValue} onChange={(e) => set("discountValue", e.target.value)} className={inputClass} />
                </label>
              )}
              <label className="text-sm">
                <span className="text-[var(--muted-foreground)]">Deposit %</span>
                <input aria-label="Deposit percent" inputMode="numeric" placeholder="none" value={form.depositPercent} onChange={(e) => set("depositPercent", e.target.value.replace(/\D/g, ""))} className={inputClass} />
              </label>
            </div>

            {(["assumptions", "exclusions", "terms"] as const).map((k) => (
              <label key={k} className="block text-sm">
                <span className="text-[var(--muted-foreground)] capitalize">{k} (markdown)</span>
                <textarea aria-label={k[0].toUpperCase() + k.slice(1)} rows={3} maxLength={20000} value={form[k]} onChange={(e) => set(k, e.target.value)} className={inputClass} />
              </label>
            ))}
          </>
        )}
      </div>

      <aside className="space-y-4">
        <div className="border border-[var(--border)] rounded-xl p-4 space-y-1 text-sm lg:sticky lg:top-4" data-testid="builder-totals">
          <div className="flex justify-between"><span className="text-[var(--muted-foreground)]">Subtotal</span><span>{formatCurrency(totals.oneTimeSubtotalCents, currency)}</span></div>
          {totals.discountCents > 0 && (
            <div className="flex justify-between"><span className="text-[var(--muted-foreground)]">Discount</span><span>-{formatCurrency(totals.discountCents, currency)}</span></div>
          )}
          <div className="flex justify-between"><span className="text-[var(--muted-foreground)]">Tax</span><span>{formatCurrency(totals.taxCents, currency)}</span></div>
          <div className="flex justify-between font-semibold border-t border-[var(--border)] pt-1"><span>Total</span><span data-testid="builder-total">{formatCurrency(totals.totalCents, currency)}</span></div>
          {totals.depositCents > 0 && (
            <div className="flex justify-between text-[var(--muted-foreground)]"><span>Deposit</span><span>{formatCurrency(totals.depositCents, currency)}</span></div>
          )}
          {Object.entries(recurring).map(([k, v]) => (
            <div key={k} className="flex justify-between text-[var(--muted-foreground)]"><span>{INTERVAL_LABELS[k]}</span><span>{formatCurrency(v, currency)}</span></div>
          ))}
          <div className="pt-2 mt-2 border-t border-[var(--border)] text-xs text-[var(--muted-foreground)]" data-testid="builder-margin">
            Internal margin: {formatCurrency(margin.margin, currency)}
            {margin.pct != null && ` (${margin.pct}%)`} · cost {formatCurrency(margin.cost, currency)}
          </div>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full mt-3 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Saving..." : estimateId ? "Save draft" : "Create draft"}
          </button>
        </div>
      </aside>
    </div>
  );
}
