"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Wrench, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  ANNOUNCEMENT_TYPE_LABELS,
  announcementSubtitle,
  severityStyle,
  type PortalAnnouncement,
} from "@/lib/announcements";

/**
 * Active incidents and upcoming or ongoing maintenance for the signed-in client.
 * With `categoryId` it shows only incidents tagged with that ticket category
 * (used on the ticket form). `initialItems` skips the first fetch when the
 * page already has them.
 */
export function AnnouncementBanner({
  categoryId,
  initialItems,
}: {
  categoryId?: string;
  initialItems?: PortalAnnouncement[];
}): React.ReactElement | null {
  const toast = useToast();
  const [items, setItems] = useState<PortalAnnouncement[]>(initialItems ?? []);

  useEffect(() => {
    if (initialItems && !categoryId) return;
    let cancelled = false;
    const path = categoryId
      ? `/announcements/mine/for-category/${encodeURIComponent(categoryId)}`
      : "/announcements/mine/banner";
    apiFetch<PortalAnnouncement[]>(path)
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch(() => {
        // The banner is advisory; a failed load just shows nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [categoryId, initialItems]);

  const dismiss = async (id: string): Promise<void> => {
    try {
      await apiFetch(`/announcements/mine/${id}/dismiss`, { method: "POST" });
      setItems((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not dismiss");
    }
  };

  if (items.length === 0) return null;

  return (
    <div className="space-y-2 mb-6" data-testid="announcement-banner" role="region" aria-label="Service announcements">
      {items.map((a) => {
        const Icon = a.type === "maintenance" ? Wrench : AlertTriangle;
        const subtitle = announcementSubtitle(a);
        return (
          <div
            key={a.id}
            className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${severityStyle(a.severity).box}`}
            data-testid="announcement-banner-item"
          >
            <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">
                <span className="uppercase text-xs tracking-wide mr-2 opacity-80">
                  {ANNOUNCEMENT_TYPE_LABELS[a.type] ?? a.type}
                </span>
                {a.title}
              </p>
              {(subtitle || a.impact) && (
                <p className="text-xs mt-0.5 opacity-90">
                  {subtitle}
                  {subtitle && a.impact ? " · " : ""}
                  {a.impact}
                </p>
              )}
            </div>
            <Link
              href={`/portal/announcements?id=${encodeURIComponent(a.id)}`}
              className="text-xs font-medium underline shrink-0 mt-0.5"
            >
              Details
            </Link>
            {a.canDismiss && (
              <button
                type="button"
                onClick={() => dismiss(a.id)}
                aria-label={`Dismiss ${a.title}`}
                className="shrink-0 opacity-70 hover:opacity-100"
              >
                <X size={16} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
