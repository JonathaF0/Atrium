"use client";

import { useEffect, useState } from "react";
import { postAuth } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

/** Better Auth answers a password sign-in that still needs a code with `{ twoFactorRedirect: true }`. */
export function needsTwoFactor(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true;
}

/** The second sign-in step: a code from the authenticator app, or a backup code. */
export function TwoFactorChallenge({ onSignedIn, onCancel }: { onSignedIn: () => void | Promise<void>; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const result = await postAuth(useBackup ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp", {
      code: code.trim(),
      trustDevice,
    });
    if (!result.ok) {
      setError(result.message || "That code is not valid");
      setLoading(false);
      return;
    }
    await onSignedIn();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Two-factor authentication</h1>
          <p className="text-[var(--muted-foreground)] mt-2">
            {useBackup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app."}
          </p>
        </div>
        {error && <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg">{error}</div>}
        <div className="space-y-2">
          <label htmlFor="two-factor-code" className="text-sm font-medium">
            {useBackup ? "Backup code" : "Authentication code"}
          </label>
          <input
            id="two-factor-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={useBackup ? "text" : "numeric"}
            autoComplete="one-time-code"
            autoFocus
            required
            className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} />
          Trust this device for 30 days
        </label>
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2 bg-[var(--primary)] text-white rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {loading ? "Verifying..." : "Verify"}
        </button>
        <div className="flex justify-between text-sm">
          <button type="button" onClick={() => setUseBackup((v) => !v)} className="text-[var(--primary)] hover:underline">
            {useBackup ? "Use authenticator code" : "Use a backup code"}
          </button>
          <button type="button" onClick={onCancel} className="text-[var(--muted-foreground)] hover:underline">
            Back to sign in
          </button>
        </div>
      </form>
    </div>
  );
}

/** "Sign in with SSO", shown only when the server has single sign-on turned on. */
export function SsoSignIn({ email, next }: { email: string; next: string | null }) {
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/security/sign-in/options`)
      .then((res) => (res.ok ? res.json() : { sso: false }))
      .then((options: { sso: boolean }) => setAvailable(options.sso))
      .catch(() => setAvailable(false));
  }, []);

  if (!available) return null;

  const start = async (): Promise<void> => {
    if (!email.includes("@")) {
      setError("Enter your work email to sign in with SSO.");
      return;
    }
    setLoading(true);
    setError("");
    const origin = window.location.origin;
    try {
      const res = await fetch(`${API_URL}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email,
          callbackURL: `${origin}${next ?? "/dashboard"}`,
          errorCallbackURL: `${origin}/login?error=sso`,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
      if (!res.ok || !data.url) throw new Error(data.message || "Single sign-on is not set up for that email domain");
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start single sign-on");
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={start}
        disabled={loading}
        className="w-full py-2 border border-[var(--border)] rounded-lg font-medium hover:bg-[var(--muted)] transition-colors disabled:opacity-50"
      >
        {loading ? "Redirecting..." : "Sign in with SSO"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
