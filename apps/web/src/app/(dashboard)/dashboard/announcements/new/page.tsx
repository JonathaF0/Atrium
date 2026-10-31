"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AnnouncementEditor } from "../announcement-editor";

export default function NewAnnouncementPage(): React.ReactElement {
  return (
    <div>
      <Link
        href="/dashboard/announcements"
        className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] mb-4"
      >
        <ArrowLeft size={14} />
        Announcements
      </Link>
      <h1 className="text-2xl font-bold mb-6">New announcement</h1>
      <AnnouncementEditor />
    </div>
  );
}
