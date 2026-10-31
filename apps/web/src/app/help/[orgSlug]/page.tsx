"use client";

import { useParams } from "next/navigation";
import { KbHome } from "@/components/kb-reader";

export default function PublicHelpCenterPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return (
    <KbHome
      source={{
        apiBase: `/kb/public/${encodeURIComponent(orgSlug)}`,
        linkBase: `/help/${orgSlug}`,
        publicOrgSlug: orgSlug,
      }}
    />
  );
}
