"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, ArrowDown, ArrowUp, Layers, Package, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useDebounce } from "@/hooks/use-debounce";
import { useCurrency } from "@/lib/app-config";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";
import { Pagination } from "@/components/pagination";
import {
  BILLING_TYPE_LABELS,
  INTERVAL_LABELS,
  INTERVAL_SUFFIX,
  centsToInput,
  parseMoneyInput,
  parseQuantity,
} from "@/lib/estimates";

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
  archivedAt: string | null;
}

interface BundleItem {
  id: string;
  catalogItemId: string;
  quantity: number;
  optional: boolean;
  catalogItem: CatalogItem;
}

interface Bundle {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  items: BundleItem[];
}

interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

const inputClass =
  "w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm outline-none focus:ring-1 focus:ring-[var(--primary)]";

interface ItemForm {
  name: string;
  description: string;
  category: string;
  unit: string;
  billingType: string;
  recurringInterval: string;
  rate: string;
  cost: string;
  taxable: boolean;
}

const EMPTY_ITEM: ItemForm = {
  name: "",
  description: "",
  category: "",
  unit: "",
  billingType: "fixed",
  recurringInterval: "monthly",
  rate: "",
  cost: "",
  taxable: true,
};

function ItemEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: ItemForm;
  onSave: (form: ItemForm) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ItemForm>(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ItemForm>(k: K, v: ItemForm[K]): void => setForm((f) => ({ ...f, [k]: v }));
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSave(form);
        } finally {
          setSaving(false);
        }
      }}
      className="p-4 border border-[var(--border)] rounded-xl space-y-3 bg-[var(--background)]"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-[var(--muted-foreground)]">Name</span>
          <input aria-label="Item name" required maxLength={200} value={form.name} onChange={(e) => set("name", e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm">
          <span className="text-[var(--muted-foreground)]">Category</span>
          <input aria-label="Category" maxLength={100} value={form.category} onChange={(e) => set("category", e.target.value)} className={inputClass} />
        </label>
      </div>
      <label className="text-sm block">
        <span className="text-[var(--muted-foreground)]">Description</span>
        <textarea aria-label="Description" maxLength={5000} rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} className={inputClass} />
      </label>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <label className="text-sm">
          <span className="text-[var(--muted-foreground)]">Billing</span>
          <select aria-label="Billing type" value={form.billingType} onChange={(e) => set("billingType", e.target.value)} className={inputClass}>
            {Object.entries(BILLING_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        {form.billingType === "recurring" && (
          <label className="text-sm">
            <span className="text-[var(--muted-foreground)]">Interval</span>
            <select aria-label="Interval" value={form.recurringInterval} onChange={(e) => set("recurringInterval", e.target.value)} className={inputClass}>
              {Object.entries(INTERVAL_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          <span className="text-[var(--muted-foreground)]">Unit</span>
          <input aria-label="Unit" maxLength={30} placeholder={form.billingType === "hourly" ? "hour" : "each"} value={form.unit} onChange={(e) => set("unit", e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm">
          <span className="text-[var(--muted-foreground)]">Rate</span>
          <input aria-label="Rate" required inputMode="decimal" placeholder="0.00" value={form.rate} onChange={(e) => set("rate", e.target.value)} className={inputClass} />
        </label>
        <label className="text-sm">
          <span className="text-[var(--muted-foreground)]">Cost (internal)</span>
          <input aria-label="Cost" inputMode="decimal" placeholder="optional" value={form.cost} onChange={(e) => set("cost", e.target.value)} className={inputClass} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.taxable} onChange={(e) => set("taxable", e.target.checked)} />
        Taxable
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={saving || !form.name.trim()} className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-50">
          {saving ? "Saving..." : "Save item"}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]">
          Cancel
        </button>
      </div>
    </form>
  );
}

function itemPayload(form: ItemForm) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    category: form.category.trim() || null,
    unit: form.unit.trim() || undefined,
    billingType: form.billingType,
    recurringInterval: form.billingType === "recurring" ? form.recurringInterval : null,
    rateCents: parseMoneyInput(form.rate),
    costCents: form.cost.trim() ? parseMoneyInput(form.cost) : null,
    taxable: form.taxable,
  };
}

function ItemsTab() {
  const currency = useCurrency();
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const debounced = useDebounce(search, 300);
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [editing, setEditing] = useState<string | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (debounced) params.set("search", debounced);
      if (archived) params.set("archived", "true");
      const res = await apiFetch<Paginated<CatalogItem>>(`/catalog/items?${params}`);
      setItems(res.data);
      setTotalPages(res.meta.totalPages);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to load catalog");
    } finally {
      setLoading(false);
    }
  }, [page, debounced, archived, showError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => setPage(1), [debounced, archived]);

  async function save(id: string | null, form: ItemForm): Promise<void> {
    try {
      await apiFetch(id ? `/catalog/items/${id}` : "/catalog/items", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(itemPayload(form)),
      });
      success(id ? "Item updated" : "Item added");
      setEditing(null);
      load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save item");
    }
  }

  async function toggleArchive(item: CatalogItem): Promise<void> {
    try {
      await apiFetch(`/catalog/items/${item.id}`, { method: "PUT", body: JSON.stringify({ archived: !item.archivedAt }) });
      success(item.archivedAt ? "Item restored" : "Item archived");
      load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to update item");
    }
  }

  async function remove(item: CatalogItem): Promise<void> {
    const ok = await confirm({
      title: "Delete item",
      message: `Delete "${item.name}"? Estimates that already use it keep their copy of the line.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/catalog/items/${item.id}`, { method: "DELETE" });
      success("Item deleted");
      load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete item");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-0 sm:max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items..."
            maxLength={200}
            className="w-full pl-9 pr-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Show archived
        </label>
        <button
          onClick={() => setEditing("new")}
          className="ml-auto flex items-center gap-2 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium hover:opacity-90"
        >
          <Plus size={16} /> New item
        </button>
      </div>

      {editing === "new" && <ItemEditor initial={EMPTY_ITEM} onSave={(f) => save(null, f)} onCancel={() => setEditing(null)} />}

      {loading ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
      ) : items.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-[var(--border)] rounded-xl text-sm text-[var(--muted-foreground)]">
          <Package size={24} className="mx-auto mb-2" />
          {debounced ? "No items match your search." : "No catalog items yet. Add the services you sell to reuse them in estimates."}
        </div>
      ) : (
        <div className="border border-[var(--border)] rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="bg-[var(--muted)] text-left">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Billing</th>
                <th className="px-3 py-2 font-medium text-right">Rate</th>
                <th className="px-3 py-2 font-medium text-right">Cost</th>
                <th className="px-3 py-2 font-medium text-right">Margin</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) =>
                editing === item.id ? (
                  <tr key={item.id}>
                    <td colSpan={7} className="p-2">
                      <ItemEditor
                        initial={{
                          name: item.name,
                          description: item.description ?? "",
                          category: item.category ?? "",
                          unit: item.unit,
                          billingType: item.billingType,
                          recurringInterval: item.recurringInterval ?? "monthly",
                          rate: centsToInput(item.rateCents),
                          cost: centsToInput(item.costCents),
                          taxable: item.taxable,
                        }}
                        onSave={(f) => save(item.id, f)}
                        onCancel={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={item.id} data-testid="catalog-item-row" className="border-t border-[var(--border)]">
                    <td className="px-3 py-2">
                      <div className="font-medium">{item.name}</div>
                      {item.description && <div className="text-xs text-[var(--muted-foreground)] line-clamp-1">{item.description}</div>}
                    </td>
                    <td className="px-3 py-2 text-[var(--muted-foreground)]">{item.category ?? "—"}</td>
                    <td className="px-3 py-2">
                      {BILLING_TYPE_LABELS[item.billingType] ?? item.billingType}
                      {item.billingType === "recurring" && item.recurringInterval && (
                        <span className="text-[var(--muted-foreground)]"> · {INTERVAL_LABELS[item.recurringInterval]}</span>
                      )}
                      {!item.taxable && <span className="ml-1 text-xs text-[var(--muted-foreground)]">(no tax)</span>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {formatCurrency(item.rateCents, currency)}
                      <span className="text-xs text-[var(--muted-foreground)]">
                        {" "}
                        {item.billingType === "recurring" && item.recurringInterval ? INTERVAL_SUFFIX[item.recurringInterval] : `/ ${item.unit}`}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--muted-foreground)]">
                      {item.costCents != null ? formatCurrency(item.costCents, currency) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--muted-foreground)]">
                      {item.costCents != null && item.rateCents > 0
                        ? `${Math.round(((item.rateCents - item.costCents) / item.rateCents) * 100)}%`
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2 text-[var(--muted-foreground)]">
                        <button aria-label={`Edit ${item.name}`} onClick={() => setEditing(item.id)} className="hover:text-[var(--foreground)]">
                          <Pencil size={14} />
                        </button>
                        <button aria-label={`${item.archivedAt ? "Restore" : "Archive"} ${item.name}`} onClick={() => toggleArchive(item)} className="hover:text-[var(--foreground)]">
                          <Archive size={14} />
                        </button>
                        <button aria-label={`Delete ${item.name}`} onClick={() => remove(item)} className="hover:text-red-600">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

interface BundleLine {
  catalogItemId: string;
  quantity: string;
  optional: boolean;
}

function BundleEditor({
  initial,
  items,
  onSave,
  onCancel,
}: {
  initial: { name: string; description: string; lines: BundleLine[] };
  items: CatalogItem[];
  onSave: (v: { name: string; description: string; lines: BundleLine[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [lines, setLines] = useState<BundleLine[]>(initial.lines);
  const [pick, setPick] = useState("");
  const [saving, setSaving] = useState(false);
  const byId = new Map(items.map((i) => [i.id, i]));

  function move(index: number, delta: number): void {
    setLines((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSave({ name, description, lines });
        } finally {
          setSaving(false);
        }
      }}
      className="p-4 border border-[var(--border)] rounded-xl space-y-3"
    >
      <input aria-label="Bundle name" required maxLength={200} placeholder="Bundle name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      <textarea aria-label="Bundle description" maxLength={5000} rows={2} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={`${l.catalogItemId}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex-1 min-w-[10rem]">{byId.get(l.catalogItemId)?.name ?? "Unknown item"}</span>
            <input
              aria-label="Bundle quantity"
              inputMode="decimal"
              value={l.quantity}
              onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
              className="w-20 px-2 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm"
            />
            <label className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
              <input type="checkbox" checked={l.optional} onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, optional: e.target.checked } : x)))} />
              Optional
            </label>
            <button type="button" aria-label="Move up" onClick={() => move(i, -1)} className="p-1 text-[var(--muted-foreground)]"><ArrowUp size={14} /></button>
            <button type="button" aria-label="Move down" onClick={() => move(i, 1)} className="p-1 text-[var(--muted-foreground)]"><ArrowDown size={14} /></button>
            <button type="button" aria-label="Remove from bundle" onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))} className="p-1 text-[var(--muted-foreground)] hover:text-red-600"><Trash2 size={14} /></button>
          </div>
        ))}
        <div className="flex gap-2">
          <select aria-label="Add item to bundle" value={pick} onChange={(e) => setPick(e.target.value)} className={`${inputClass} sm:max-w-xs`}>
            <option value="">Add an item...</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!pick}
            onClick={() => {
              setLines((prev) => [...prev, { catalogItemId: pick, quantity: "1", optional: false }]);
              setPick("");
            }}
            className="px-3 py-2 border border-[var(--border)] rounded-lg text-sm disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving || !name.trim()} className="px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm disabled:opacity-50">
          {saving ? "Saving..." : "Save bundle"}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)]">
          Cancel
        </button>
      </div>
    </form>
  );
}

function BundlesTab() {
  const currency = useCurrency();
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [search, setSearch] = useState("");
  const debounced = useDebounce(search, 300);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (debounced) params.set("search", debounced);
      const [b, i] = await Promise.all([
        apiFetch<Bundle[]>(`/catalog/bundles?${params}`),
        apiFetch<Paginated<CatalogItem>>("/catalog/items?limit=100"),
      ]);
      setBundles(b);
      setItems(i.data);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to load bundles");
    } finally {
      setLoading(false);
    }
  }, [debounced, showError]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(id: string | null, v: { name: string; description: string; lines: BundleLine[] }): Promise<void> {
    try {
      await apiFetch(id ? `/catalog/bundles/${id}` : "/catalog/bundles", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify({
          name: v.name.trim(),
          description: v.description.trim() || null,
          items: v.lines.map((l) => ({ catalogItemId: l.catalogItemId, quantity: parseQuantity(l.quantity) || 1, optional: l.optional })),
        }),
      });
      success(id ? "Bundle updated" : "Bundle created");
      setEditing(null);
      load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save bundle");
    }
  }

  async function remove(b: Bundle): Promise<void> {
    const ok = await confirm({ title: "Delete bundle", message: `Delete "${b.name}"?`, confirmLabel: "Delete", variant: "danger" });
    if (!ok) return;
    try {
      await apiFetch(`/catalog/bundles/${b.id}`, { method: "DELETE" });
      success("Bundle deleted");
      load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete bundle");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-0 sm:max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search bundles..." maxLength={200} className="w-full pl-9 pr-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm" />
        </div>
        <button onClick={() => setEditing("new")} className="ml-auto flex items-center gap-2 px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium hover:opacity-90">
          <Plus size={16} /> New bundle
        </button>
      </div>
      {editing === "new" && (
        <BundleEditor initial={{ name: "", description: "", lines: [] }} items={items} onSave={(v) => save(null, v)} onCancel={() => setEditing(null)} />
      )}
      {loading ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
      ) : bundles.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-[var(--border)] rounded-xl text-sm text-[var(--muted-foreground)]">
          <Layers size={24} className="mx-auto mb-2" />
          No bundles yet. Group items you often sell together.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {bundles.map((b) =>
            editing === b.id ? (
              <div key={b.id} className="md:col-span-2">
                <BundleEditor
                  initial={{
                    name: b.name,
                    description: b.description ?? "",
                    lines: b.items.map((i) => ({ catalogItemId: i.catalogItemId, quantity: String(i.quantity), optional: i.optional })),
                  }}
                  items={[...items, ...b.items.map((i) => i.catalogItem).filter((ci) => !items.some((x) => x.id === ci.id))]}
                  onSave={(v) => save(b.id, v)}
                  onCancel={() => setEditing(null)}
                />
              </div>
            ) : (
              <div key={b.id} data-testid="catalog-bundle-card" className="border border-[var(--border)] rounded-xl p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium">{b.name}</h3>
                    {b.description && <p className="text-xs text-[var(--muted-foreground)]">{b.description}</p>}
                  </div>
                  <div className="flex gap-2 text-[var(--muted-foreground)]">
                    <button aria-label={`Edit ${b.name}`} onClick={() => setEditing(b.id)} className="hover:text-[var(--foreground)]"><Pencil size={14} /></button>
                    <button aria-label={`Delete ${b.name}`} onClick={() => remove(b)} className="hover:text-red-600"><Trash2 size={14} /></button>
                  </div>
                </div>
                <ul className="text-sm space-y-1">
                  {b.items.map((i) => (
                    <li key={i.id} className="flex justify-between gap-2">
                      <span>
                        {i.quantity} × {i.catalogItem.name}
                        {i.optional && <span className="ml-1 text-xs text-[var(--muted-foreground)]">(optional)</span>}
                      </span>
                      <span className="text-[var(--muted-foreground)]">{formatCurrency(Math.round(i.quantity * i.catalogItem.rateCents), currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export default function CatalogPage() {
  const [tab, setTab] = useState<"items" | "bundles">("items");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Catalog</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">Services and products you sell, reused when building estimates.</p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-[var(--border)]">
        {(["items", "bundles"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium relative ${tab === t ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
          >
            {t === "items" ? "Items" : "Bundles"}
            {tab === t && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--primary)]" />}
          </button>
        ))}
      </div>
      {tab === "items" ? <ItemsTab /> : <BundlesTab />}
    </div>
  );
}
