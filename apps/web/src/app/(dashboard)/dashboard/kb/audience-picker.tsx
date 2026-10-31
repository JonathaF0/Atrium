"use client";

import { useEffect, useState } from "react";
import { fetchAllPages } from "@/lib/api";

export interface CompanyOption {
  id: string;
  name: string;
}

let companiesPromise: Promise<CompanyOption[]> | null = null;

/** The workspace's CRM companies, loaded once per page view. */
export function useCompanies(): CompanyOption[] {
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  useEffect(() => {
    companiesPromise ??= fetchAllPages<CompanyOption>("/companies").catch(() => {
      companiesPromise = null;
      return [];
    });
    companiesPromise.then(setCompanies);
  }, []);
  return companies;
}

/** Checkbox list of companies allowed to read restricted content. */
export function AudiencePicker({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const companies: CompanyOption[] = useCompanies();
  const set = new Set(selected);
  if (companies.length === 0) {
    return <p className="text-xs text-[var(--muted-foreground)]">Add companies under Contacts to restrict content to them.</p>;
  }
  return (
    <div className="max-h-40 overflow-y-auto border border-[var(--border)] rounded-lg p-2 space-y-1" role="group" aria-label="Companies">
      {companies.map((c) => (
        <label key={c.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={set.has(c.id)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))}
          />
          {c.name}
        </label>
      ))}
    </div>
  );
}
