"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

const linkClass = "text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]";

/** Portal header links for assets, and for contracts when the client can see any. */
export function PortalServiceLinks() {
  const [hasContracts, setHasContracts] = useState(false);

  useEffect(() => {
    apiFetch<unknown[]>("/contracts/mine")
      .then((rows) => setHasContracts(Array.isArray(rows) && rows.length > 0))
      .catch(() => setHasContracts(false));
  }, []);

  return (
    <>
      <Link href="/portal/assets" className={linkClass}>
        Assets
      </Link>
      {hasContracts && (
        <Link href="/portal/contracts" className={linkClass}>
          Contracts
        </Link>
      )}
    </>
  );
}
