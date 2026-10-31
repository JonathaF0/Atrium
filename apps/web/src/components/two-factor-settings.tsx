"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { ShieldCheck } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { postAuth } from "@/lib/auth-fetch";
import { useToast } from "@/components/toast";

interface Status {
  enabled: boolean;
  required: boolean;
  mustEnroll: boolean;
}

const inputClass = "w-full mt-1 px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)]";
const buttonClass = "px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium disabled:opacity-50";

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Save these backup codes somewhere safe. Each one signs you in once if you lose your authenticator.
      </p>
      <ul aria-label="Backup codes" className="grid grid-cols-2 gap-1 font-mono text-sm p-3 rounded-lg bg-[var(--muted)]">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <button type="button" onClick={onDone} className={buttonClass}>
        I saved my codes
      </button>
    </div>
  );
}

/**
 * Turn TOTP two-factor authentication on or off, and manage backup codes.
 * Used on the dashboard account page, the portal settings page and the
 * enrolment page a workspace's 2FA requirement sends people to.
 */
export function TwoFactorSettings({ onEnabled, headingClassName = "text-base font-semibold" }: { onEnabled?: () => void; headingClassName?: string }) {
  const { success, error: showError } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [hasPassword, setHasPassword] = useState(true);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ uri: string; secret: string; qr: string; backupCodes: string[] } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"idle" | "disable" | "regenerate">("idle");

  const load = useCallback(async () => {
    const [s, pw] = await Promise.all([
      apiFetch<Status>("/security/two-factor/status"),
      apiFetch<{ hasPassword: boolean }>("/account/password").catch(() => ({ hasPassword: true })),
    ]);
    setStatus(s);
    setHasPassword(pw.hasPassword);
  }, []);

  useEffect(() => {
    load().catch((err) => console.error("Could not load two-factor status", err));
  }, [load]);

  const start = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await postAuthJson<{ totpURI: string; backupCodes: string[] }>("/two-factor/enable", hasPassword ? { password } : {});
      const secret = new URL(res.totpURI).searchParams.get("secret") ?? "";
      const qr = await QRCode.toDataURL(res.totpURI, { margin: 1, width: 192 });
      setSetup({ uri: res.totpURI, secret, qr, backupCodes: res.backupCodes });
      setPassword("");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Could not start two-factor setup");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!setup) return;
    setBusy(true);
    try {
      const result = await postAuth("/two-factor/verify-totp", { code: code.trim() });
      if (!result.ok) throw new Error(result.message || "That code is not valid");
      setCodes(setup.backupCodes);
      setSetup(null);
      setCode("");
      success("Two-factor authentication is on");
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "That code is not valid");
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await postAuth("/two-factor/disable", hasPassword ? { password } : { code: code.trim() });
      if (!result.ok) throw new Error(result.message || "Could not turn off two-factor authentication");
      success("Two-factor authentication is off");
      setMode("idle");
      setPassword("");
      setCode("");
      await load();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Could not turn off two-factor authentication");
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await postAuthJson<{ backupCodes: string[] }>("/two-factor/generate-backup-codes", hasPassword ? { password } : {});
      setCodes(res.backupCodes);
      setMode("idle");
      setPassword("");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Could not generate new codes");
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  return (
    <section aria-labelledby="two-factor-heading" className="max-w-md space-y-3">
      <h2 id="two-factor-heading" className={`${headingClassName} flex items-center gap-2`}>
        <ShieldCheck size={18} /> Two-factor authentication
      </h2>

      {codes ? (
        <BackupCodes
          codes={codes}
          onDone={() => {
            setCodes(null);
            onEnabled?.();
          }}
        />
      ) : status.enabled ? (
        <>
          <p className="text-sm text-[var(--muted-foreground)]">
            On. You enter a code from your authenticator app when you sign in.
            {status.required ? " Your workspace requires it." : ""}
          </p>
          {mode === "idle" && (
            <div className="flex gap-2">
              <button type="button" onClick={() => setMode("regenerate")} className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm">
                New backup codes
              </button>
              {!status.required && (
                <button type="button" onClick={() => setMode("disable")} className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm text-red-600">
                  Turn off
                </button>
              )}
            </div>
          )}
          {mode !== "idle" && (
            <form onSubmit={mode === "disable" ? disable : regenerate} className="space-y-3">
              {hasPassword ? (
                <label className="block text-sm text-[var(--muted-foreground)]">
                  Current password
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className={inputClass} />
                </label>
              ) : mode === "disable" ? (
                <label className="block text-sm text-[var(--muted-foreground)]">
                  Code from your authenticator app
                  <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required className={inputClass} />
                </label>
              ) : null}
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className={buttonClass}>
                  {mode === "disable" ? "Turn off two-factor" : "Generate codes"}
                </button>
                <button type="button" onClick={() => setMode("idle")} className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      ) : setup ? (
        <form onSubmit={confirm} className="space-y-3">
          <p className="text-sm">Scan this code with an authenticator app, then enter the 6-digit code it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded-lg border border-[var(--border)]" />
          <p className="text-xs text-[var(--muted-foreground)] break-all">
            Can&apos;t scan it? Enter this key: <code data-testid="totp-secret">{setup.secret}</code>
          </p>
          <label className="block text-sm text-[var(--muted-foreground)]">
            Authentication code
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required className={inputClass} />
          </label>
          <button type="submit" disabled={busy} className={buttonClass}>
            Verify and turn on
          </button>
        </form>
      ) : (
        <form onSubmit={start} className="space-y-3">
          <p className="text-sm text-[var(--muted-foreground)]">
            Add a second step to signing in with a code from an authenticator app.
            {status.required ? " Your workspace requires it." : ""}
          </p>
          {hasPassword && (
            <label className="block text-sm text-[var(--muted-foreground)]">
              Current password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className={inputClass} />
            </label>
          )}
          <button type="submit" disabled={busy} className={buttonClass}>
            Set up two-factor
          </button>
        </form>
      )}
    </section>
  );
}

/** POST to a Better Auth route and return its JSON body. */
async function postAuthJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(data.message || "Request failed");
  return data;
}
