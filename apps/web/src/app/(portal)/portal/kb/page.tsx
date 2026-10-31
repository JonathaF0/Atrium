"use client";

import { KbHome } from "@/components/kb-reader";

const SOURCE = { apiBase: "/kb/mine", linkBase: "/portal/kb" };

export default function PortalKbPage() {
  return <KbHome source={SOURCE} />;
}
