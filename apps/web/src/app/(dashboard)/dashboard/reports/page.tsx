import Link from "next/link";
import { BarChart3, Clock, Gauge, Hourglass, Smile, Ticket, Wallet, Timer } from "lucide-react";

const CARDS = [
  { href: "/dashboard/reports/time", title: "Time", icon: Clock, text: "Hours by project, task and person." },
  { href: "/dashboard/reports/tickets", title: "Ticket volume", icon: Ticket, text: "Created vs resolved, backlog, and breakdowns by category, priority, source and company." },
  { href: "/dashboard/reports/sla", title: "SLA compliance", icon: Gauge, text: "First response and resolution targets met, and the tickets that breached them." },
  { href: "/dashboard/reports/response-times", title: "Response times", icon: Timer, text: "Median and 90th percentile first response and resolution times." },
  { href: "/dashboard/reports/csat", title: "Satisfaction", icon: Smile, text: "Average rating, response rate, distribution and recent comments." },
  { href: "/dashboard/reports/hours", title: "Hours by client", icon: Hourglass, text: "Billable, contract-covered and un-invoiced hours per company, with overage." },
  { href: "/dashboard/reports/revenue", title: "Revenue and aging", icon: Wallet, text: "Invoiced, collected and outstanding, receivables aging, MRR and estimate pipeline." },
];

export default function ReportsIndex(): React.ReactElement {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BarChart3 size={22} />
        <h1 className="text-2xl font-bold">Reports</h1>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map(({ href, title, icon: Icon, text }) => (
          <Link
            key={href}
            href={href}
            className="border border-[var(--border)] rounded-lg p-4 hover:bg-[var(--muted)] transition-colors"
          >
            <div className="flex items-center gap-2 font-medium">
              <Icon size={18} className="text-[var(--primary)]" />
              {title}
            </div>
            <p className="text-sm text-[var(--muted-foreground)] mt-1">{text}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
