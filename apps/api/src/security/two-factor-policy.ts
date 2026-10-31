export const TWO_FACTOR_SCOPES = ["staff", "all"] as const;
export type TwoFactorScope = (typeof TWO_FACTOR_SCOPES)[number];

/** Error code the API returns while an enrolment is required; the web app redirects on it. */
export const TWO_FACTOR_REQUIRED_CODE = "TWO_FACTOR_REQUIRED";

export interface EnforcementSettings {
  requireTwoFactor: boolean;
  twoFactorScope: string;
}

/** Whether the workspace requires this role to use two-factor authentication. */
export function twoFactorRequiredFor(settings: EnforcementSettings | null, role: string | undefined): boolean {
  if (!settings?.requireTwoFactor || !role) return false;
  if (settings.twoFactorScope === "all") return true;
  return role === "owner" || role === "admin";
}

/**
 * Routes an unenrolled user can still reach while enrolment is required:
 * sign-in/out and the 2FA endpoints (all under /api/auth), the security
 * status and settings, their own account, and what the app shell needs to
 * render the enrolment page.
 */
const EXEMPT_PREFIXES = [
  "/api/auth/",
  "/api/security/",
  "/api/account",
  "/api/organization/current",
  "/api/branding",
  "/api/health",
  "/api/sign-in-options",
  "/api/setup/status",
  "/api/.well-known/",
  "/api/notifications",
];

export function isEnforcementExempt(path: string): boolean {
  const clean = path.split("?")[0];
  return EXEMPT_PREFIXES.some((entry) => {
    const prefix = entry.replace(/\/$/, "");
    return clean === prefix || clean.startsWith(`${prefix}/`);
  });
}
