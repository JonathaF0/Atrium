"use client";

import { useParams } from "next/navigation";
import { KbArticleView } from "@/components/kb-reader";

const SOURCE = { apiBase: "/kb/mine", linkBase: "/portal/kb" };

export default function PortalKbArticlePage() {
  const { slug } = useParams<{ slug: string }>();
  return <KbArticleView source={SOURCE} slug={slug} />;
}
