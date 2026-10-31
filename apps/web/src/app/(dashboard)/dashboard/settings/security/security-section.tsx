"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session-context";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm-modal";

interface SecuritySettings {
  requireTwoFactor: boolean;
  twoFactorScope: string;
}

interface SsoState {
  enabled: boolean;
  callbackUrl?: string;
  provider: {
    issuer: string;
    clientId: string;
    hasSecret: boolean;
    domain: string;
    domainVerified: boolean;
    verificationRecord: { name: string; value: string };
  } | null;
}

const inputClass = "w-full mt-1 px-3 py-2 border border-[var(--border)] rounded-lg bg-[var(--background)] text-sm";
const buttonClass = "px-4 py-2 bg-[var(--primary)] text-white rounded-lg text-sm font-medium disabled:opacity-50";

/** Workspace security: the two-factor requirement and OIDC single sign-on. Owner-only edits. */
export function SecuritySection() {
  const { role } = useSession();
  const isOwner = role === "owner";
  const { success, error: showError } = useToast();
  const confirm = useConfirm();
  const [settings, setSettings] = useState<SecuritySettings | null>(null);
  const [sso, setSso] = useState<SsoState | null>(null);
  const [form, setForm] = useState({ issuer: "", clientId: "", clientSecret: "", domain: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, o] = await Promise.all([apiFetch<SecuritySettings>("/security/settings"), apiFetch<SsoState>("/security/sso")]);
    setSettings(s);
    setSso(o);
    if (o.provider) setForm({ issuer: o.provider.issuer, clientId: o.provider.clientId, clientSecret: "", domain: o.provider.domain });
  }, []);

  useEffect(() => {
    load().catch((err) => console.error("Could not load security settings", err));
  }, [load]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = (next: SecuritySettings) =>
    run(async () => {
      const saved = await apiFetch<SecuritySettings>("/security/settings", { method: "PUT", body: JSON.stringify(next) });
      setSettings(saved);
      success("Security settings saved");
    });

  const saveSso = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const body = { ...form, clientSecret: form.clientSecret || undefined };
      setSso(await apiFetch<SsoState>("/security/sso", { method: "PUT", body: JSON.stringify(body) }));
      setForm((f) => ({ ...f, clientSecret: "" }));
      success("Single sign-on saved");
    });
  };

  const verifyDomain = () =>
    run(async () => {
      setSso(await apiFetch<SsoState>("/security/sso/verify-domain", { method: "POST" }));
      success("Domain verified");
    });

  const removeSso = () =>
    run(async () => {
      const ok = await confirm({ title: "Remove single sign-on?", message: "People will sign in with their password or an emailed link again.", confirmLabel: "Remove", variant: "danger" });
      if (!ok) return;
      await apiFetch("/security/sso", { method: "DELETE" });
      setForm({ issuer: "", clientId: "", clientSecret: "", domain: "" });
      await load();
      success("Single sign-on removed");
    });

  if (!settings) return null;

  return (
    <div className="space-y-8">
      <div className="max-w-xl space-y-3">
        <h2 className="text-base font-semibold">Security</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.requireTwoFactor}
            disabled={!isOwner || busy}
            onChange={(e) => saveSettings({ ...settings, requireTwoFactor: e.target.checked })}
          />
          Require two-factor authentication
        </label>
        <label className="block text-sm text-[var(--muted-foreground)] max-w-xs">
          Applies to
          <select
            className={inputClass}
            value={settings.twoFactorScope}
            disabled={!isOwner || busy}
            onChange={(e) => saveSettings({ ...settings, twoFactorScope: e.target.value })}
          >
            <option value="staff">Owners and admins</option>
            <option value="all">Everyone, including clients</option>
          </select>
        </label>
        <p className="text-xs text-[var(--muted-foreground)]">
          People it applies to are asked to set up an authenticator app before they can continue. Turn it on for your own
          account first.
        </p>
      </div>

      {sso?.enabled && (
        <form onSubmit={saveSso} className="max-w-xl space-y-3">
          <h3 className="text-sm font-semibold">Single sign-on (OpenID Connect)</h3>
          {sso.callbackUrl && (
            <p className="text-xs text-[var(--muted-foreground)] break-all">
              Redirect URI for your identity provider: <code>{sso.callbackUrl}</code>
            </p>
          )}
          <label className="block text-sm text-[var(--muted-foreground)]">
            Issuer URL
            <input className={inputClass} value={form.issuer} disabled={!isOwner} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="https://login.example.com" required />
          </label>
          <label className="block text-sm text-[var(--muted-foreground)]">
            Client ID
            <input className={inputClass} value={form.clientId} disabled={!isOwner} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required />
          </label>
          <label className="block text-sm text-[var(--muted-foreground)]">
            Client secret
            <input
              className={inputClass}
              type="password"
              value={form.clientSecret}
              disabled={!isOwner}
              onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
              placeholder={sso.provider?.hasSecret ? "Saved; leave empty to keep it" : ""}
              required={!sso.provider?.hasSecret}
            />
          </label>
          <label className="block text-sm text-[var(--muted-foreground)]">
            Email domain
            <input className={inputClass} value={form.domain} disabled={!isOwner} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="example.com" required />
          </label>
          {isOwner && (
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className={buttonClass}>
                Save single sign-on
              </button>
              {sso.provider && (
                <button type="button" onClick={removeSso} disabled={busy} className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm text-red-600">
                  Remove
                </button>
              )}
            </div>
          )}
          {sso.provider && (
            <div className="text-sm rounded-lg border border-[var(--border)] p-3 space-y-2">
              {sso.provider.domainVerified ? (
                <p>{sso.provider.domain} is verified. Members and invited people with that domain can use &quot;Sign in with SSO&quot;.</p>
              ) : (
                <>
                  <p>Prove you control {sso.provider.domain} by adding this DNS TXT record, then verify:</p>
                  <p className="font-mono text-xs break-all">
                    {sso.provider.verificationRecord.name} TXT &quot;{sso.provider.verificationRecord.value}&quot;
                  </p>
                  {isOwner && (
                    <button type="button" onClick={verifyDomain} disabled={busy} className={buttonClass}>
                      Verify domain
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
