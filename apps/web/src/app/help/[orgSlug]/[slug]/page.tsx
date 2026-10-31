"use client";

import { useParams } from "next/navigation";
import { KbArticleView } from "@/components/kb-reader";

export default function PublicHelpArticlePage() {
  const { orgSlug, slug } = useParams<{ orgSlug: string; slug: string }>();
  return (
    <KbArticleView
      source={{
        apiBase: `/kb/public/${encodeURIComponent(orgSlug)}`,
        linkBase: `/help/${orgSlug}`,
        publicOrgSlug: orgSlug,
      }}
      slug={slug}
    />
  );
}
