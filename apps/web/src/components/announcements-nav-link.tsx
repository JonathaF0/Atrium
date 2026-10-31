"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { apiFetch } from "@/lib/api";

/** Portal header link to the announcements feed, with the unread count. */
export function AnnouncementsNavLink({ className }: { className?: string }): React.ReactElement {
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);

  // Re-checked on navigation, so reading the feed clears the badge.
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ count: number }>("/announcements/mine/unread-count")
      .then((res) => {
        if (!cancelled) setUnread(res.count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return (
    <Link href="/portal/announcements" className={`${className ?? ""} inline-flex items-center gap-1.5`}>
      Announcements
      {unread > 0 && (
        <span
          className="min-w-[1.25rem] h-5 px-1 rounded-full bg-[var(--primary)] text-white text-[11px] font-semibold inline-flex items-center justify-center"
          data-testid="announcements-unread-badge"
          aria-label={`${unread} unread`}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
