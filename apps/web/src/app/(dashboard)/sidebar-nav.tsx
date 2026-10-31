"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  Settings,
  Calendar,
  BarChart3,
  Contact,
  HardDrive,
  FileSignature,
  Megaphone,
  BookOpen,
  Calculator,
  Package,
  Repeat,
  LifeBuoy,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Groups keep the longer list scannable; a group without a title renders as plain items.
const navGroups: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
      { href: "/dashboard/projects", label: "Projects", icon: FolderKanban },
      { href: "/dashboard/tickets", label: "Tickets", icon: LifeBuoy },
      { href: "/dashboard/calendar", label: "Calendar", icon: Calendar },
    ],
  },
  {
    title: "Clients",
    items: [
      { href: "/dashboard/contacts", label: "Contacts", icon: Contact },
      { href: "/dashboard/contracts", label: "Contracts", icon: FileSignature },
      { href: "/dashboard/assets", label: "Assets", icon: HardDrive },
      { href: "/dashboard/kb", label: "Knowledge base", icon: BookOpen },
      { href: "/dashboard/announcements", label: "Announcements", icon: Megaphone },
    ],
  },
  {
    title: "Sales",
    items: [
      { href: "/dashboard/estimates", label: "Estimates", icon: Calculator },
      { href: "/dashboard/catalog", label: "Catalog", icon: Package },
      { href: "/dashboard/invoices/recurring", label: "Recurring billing", icon: Repeat },
    ],
  },
  {
    items: [
      { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function SidebarNav({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();

  return (
    <nav className="flex-1 min-h-0 overflow-y-auto space-y-3">
      {navGroups.map((group, i) => (
        <div key={group.title ?? i} className="space-y-0.5">
          {group.title && (
            <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              {group.title}
            </div>
          )}
          {group.items.map(({ href, label, icon: Icon }) => {
            const isActive = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                className={`flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-[var(--muted)] font-medium"
                    : "hover:bg-[var(--muted)] text-[var(--muted-foreground)]"
                }`}
              >
                <Icon size={18} />
                {label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
