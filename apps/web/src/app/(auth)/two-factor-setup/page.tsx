"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { TwoFactorSettings } from "@/components/two-factor-settings";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

/** Where a workspace's two-factor requirement sends people who have not enrolled yet. */
export default function TwoFactorSetupPage() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    apiFetch<{ mustEnroll: boolean }>("/security/two-factor/status")
      .then((s) => {
        if (s.mustEnroll) setReady(true);
        else window.location.href = "/dashboard";
      })
      .catch(() => {
        window.location.href = "/login";
      });
  }, []);

  const signOut = async (): Promise<void> => {
    await fetch(`${API_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: "{}",
    }).catch(() => undefined);
    window.location.href = "/login";
  };

  if (!ready) return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Set up two-factor authentication</h1>
          <p className="text-[var(--muted-foreground)] mt-2">
            Your workspace requires a second sign-in step. Set it up to continue.
          </p>
        </div>
        <TwoFactorSettings onEnabled={() => (window.location.href = "/dashboard")} />
        <button type="button" onClick={signOut} className="text-sm text-[var(--muted-foreground)] hover:underline">
          Sign out
        </button>
      </div>
    </div>
  );
}
