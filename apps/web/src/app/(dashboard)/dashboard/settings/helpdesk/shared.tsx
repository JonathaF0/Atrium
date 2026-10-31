"use client";

export const inputClass = "w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";
export const smallInput = "px-2 py-1.5 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";
export const buttonClass = "px-3 py-1.5 border border-[var(--border)] rounded-lg text-sm hover:bg-[var(--muted)] disabled:opacity-50";
export const primaryButton = "px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50";

export interface Staff {
  userId: string;
  name: string;
  role: string;
}

export interface Category {
  id: string;
  name: string;
  description: string | null;
  color: string;
  defaultPriority: string;
  defaultAssigneeId: string | null;
  slaPolicyId: string | null;
  portalVisible: boolean;
  archivedAt: string | null;
  _count?: { tickets: number };
}

export interface SlaPolicy {
  id: string;
  name: string;
  targets: Record<string, { firstResponseMins: number; resolutionMins: number }>;
  businessHoursId: string | null;
  warnAtPercent: number;
  escalateToId: string | null;
}

export interface Calendar {
  id: string;
  name: string;
  timezone: string;
  schedule: { day: number; start: string; end: string }[];
  holidays: { id: string; date: string; name: string }[];
}

export function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="border border-[var(--border)] rounded-xl p-5 space-y-4" aria-label={title}>
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-sm text-[var(--muted-foreground)]">{description}</p>}
      </div>
      {children}
    </section>
  );
}
