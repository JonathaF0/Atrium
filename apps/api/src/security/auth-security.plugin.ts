import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { generateRandomString, symmetricDecrypt } from "better-auth/crypto";
import type { PrismaService } from "../prisma/prisma.service";
import { recordAuthEvent, recordOrgEvent, requestContext } from "./auth-audit";
import { verifyTotp } from "./totp";

/** Cookie and lifetime Better Auth's twoFactor plugin uses for a pending second step. */
const TWO_FACTOR_COOKIE = "two_factor";
const TWO_FACTOR_COOKIE_MAX_AGE = 600;

/**
 * The sso plugin's own provider-management routes. Providers are configured
 * through Atrium's security settings (validated, owner-only, secret sealed),
 * so these are taken off the air.
 */
export const BLOCKED_SSO_PATHS: ReadonlySet<string> = new Set([
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
]);

export interface AuthSecurityDeps {
  prisma: PrismaService;
  webUrl: string;
}

interface SessionData {
  session: { token: string; userId: string };
  user: { id: string; email: string; twoFactorEnabled?: boolean | null };
}

// Loose view of Better Auth's hook context; the plugin API types it generically.
interface HookCtx {
  path: string;
  request?: Request;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  context: {
    newSession: SessionData | null;
    setNewSession: (s: SessionData | null) => void;
    returned?: unknown;
    secret: string;
    secretConfig: unknown;
    session?: SessionData | null;
    createAuthCookie: (name: string, opts?: { maxAge?: number }) => { name: string; attributes: Record<string, unknown> };
    internalAdapter: {
      deleteSession: (token: string) => Promise<void>;
      createVerificationValue: (v: { value: string; identifier: string; expiresAt: Date }) => Promise<unknown>;
      findAccounts: (userId: string) => Promise<Array<{ providerId: string; password?: string | null }>>;
    };
    adapter: { findOne: (q: { model: string; where: Array<{ field: string; value: string }> }) => Promise<Record<string, unknown> | null> };
  };
  setSignedCookie: (name: string, value: string, secret: string, attrs: Record<string, unknown>) => Promise<void>;
  redirect: (url: string) => unknown;
}

const as = (ctx: unknown): HookCtx => ctx as HookCtx;

function succeeded(ctx: HookCtx): boolean {
  return !isAPIError(ctx.context.returned);
}

/** Per-request state handed from a before hook to the matching after hook. */
const pending = new WeakMap<Request, { signIn: boolean; userId?: string }>();

/** Where to send the browser after a sign-in that still needs the code: the login page it came from. */
function challengeUrl(ctx: HookCtx, webUrl: string): string {
  const callback = typeof ctx.query?.callbackURL === "string" ? ctx.query.callbackURL : null;
  let origin = webUrl;
  let next: string | null = null;
  if (callback) {
    try {
      const url = new URL(callback, webUrl);
      origin = url.origin;
      next = `${url.pathname}${url.search}`;
    } catch {
      // keep the defaults
    }
  }
  const target = new URL("/login", origin);
  target.searchParams.set("twoFactor", "1");
  if (next && next.startsWith("/") && !next.startsWith("//")) target.searchParams.set("next", next);
  return target.toString();
}

/**
 * Turns a sign-in that skipped the second step (a magic link or SSO) into the
 * same pending challenge a password sign-in gets: the session is dropped and
 * the two_factor cookie set, so /two-factor/verify-totp finishes it.
 */
async function demandSecondFactor(ctx: HookCtx, data: SessionData, webUrl: string): Promise<unknown> {
  deleteSessionCookie(ctx as never, true);
  await ctx.context.internalAdapter.deleteSession(data.session.token);
  ctx.context.setNewSession(null);
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE, { maxAge: TWO_FACTOR_COOKIE_MAX_AGE });
  const identifier = `2fa-${generateRandomString(20)}`;
  const expiresAt = new Date(Date.now() + TWO_FACTOR_COOKIE_MAX_AGE * 1000);
  await ctx.context.internalAdapter.createVerificationValue({ value: data.user.id, identifier, expiresAt });
  await ctx.context.internalAdapter.createVerificationValue({ value: "0", identifier: `2fa-attempts-${identifier}`, expiresAt });
  await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);
  return ctx.redirect(challengeUrl(ctx, webUrl));
}

/**
 * Atrium's additions to Better Auth: audit entries for auth events, the second
 * factor on passwordless sign-ins, a code (instead of a password) to turn 2FA
 * off for accounts that have no password, and the SSO safety rails.
 */
export function authSecurityPlugin(deps: AuthSecurityDeps): BetterAuthPlugin {
  const { prisma, webUrl } = deps;
  const audit = (ctx: HookCtx, event: Parameters<typeof recordAuthEvent>[1]): Promise<void> =>
    recordAuthEvent(prisma, { ...requestContext(ctx.request), ...event });

  return {
    id: "atrium-security",
    hooks: {
      before: [
        {
          matcher: (ctx) => BLOCKED_SSO_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async () => {
            throw new APIError("NOT_FOUND");
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/sign-out",
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            const session = await getSessionFromCtx(raw).catch(() => null);
            if (session) await audit(ctx, { action: "auth.sign_out", userId: session.user.id, email: session.user.email, summary: "Signed out" });
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code",
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            if (!ctx.request) return;
            const session = await getSessionFromCtx(raw).catch(() => null);
            pending.set(ctx.request, {
              signIn: !session,
              userId: session && !(session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled ? session.user.id : undefined,
            });
          }),
        },
        {
          // Without a password to confirm, turning 2FA off takes a current code.
          matcher: (ctx) => ctx.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            const session = await getSessionFromCtx(raw).catch(() => null);
            if (!session) return; // the endpoint itself answers 401
            const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
            if (accounts.some((a) => a.providerId === "credential" && a.password)) return;
            const code = typeof ctx.body?.code === "string" ? ctx.body.code.trim() : "";
            const row = await ctx.context.adapter.findOne({ model: "twoFactor", where: [{ field: "userId", value: session.user.id }] });
            if (!row || typeof row.secret !== "string" || !code) {
              throw new APIError("BAD_REQUEST", { message: "Enter a code from your authenticator app", code: "INVALID_CODE" });
            }
            const secret = await symmetricDecrypt({ key: ctx.context.secretConfig as never, data: row.secret });
            if (!verifyTotp(code, Buffer.from(secret, "utf8"))) {
              throw new APIError("BAD_REQUEST", { message: "That code is not valid", code: "INVALID_CODE" });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            const email = typeof ctx.body?.email === "string" ? ctx.body.email : null;
            if (!succeeded(ctx)) {
              await audit(ctx, { action: "auth.sign_in_failed", email, summary: "Failed sign-in (wrong password)", metadata: { method: "password" } });
              return;
            }
            const data = ctx.context.newSession;
            if (data) await audit(ctx, { action: "auth.sign_in", userId: data.user.id, email: data.user.email, summary: "Signed in with password", metadata: { method: "password" } });
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/magic-link/verify",
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            const data = ctx.context.newSession;
            if (!data) return;
            if (data.user.twoFactorEnabled) return demandSecondFactor(ctx, data, webUrl);
            await audit(ctx, { action: "auth.sign_in", userId: data.user.id, email: data.user.email, summary: "Signed in with an email link", metadata: { method: "magic_link" } });
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code",
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            const state = ctx.request ? pending.get(ctx.request) : undefined;
            if (ctx.request) pending.delete(ctx.request);
            const data = ctx.context.newSession;
            const method = ctx.path.endsWith("backup-code") ? "backup_code" : "totp";
            if (!succeeded(ctx)) {
              if (state?.signIn) await audit(ctx, { action: "auth.two_factor_failed", userId: null, email: null, summary: "Failed two-factor code" });
              return;
            }
            if (!data) return;
            if (state?.signIn) {
              await audit(ctx, { action: "auth.sign_in", userId: data.user.id, email: data.user.email, summary: "Signed in with two-factor authentication", metadata: { method } });
            } else if (state?.userId) {
              await audit(ctx, { action: "auth.two_factor_enabled", userId: data.user.id, email: data.user.email, summary: "Turned on two-factor authentication" });
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/two-factor/disable" || ctx.path === "/two-factor/generate-backup-codes",
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            if (!succeeded(ctx)) return;
            const user = ctx.context.session?.user ?? ctx.context.newSession?.user;
            if (!user) return;
            const disabled = ctx.path === "/two-factor/disable";
            await audit(ctx, {
              action: disabled ? "auth.two_factor_disabled" : "auth.backup_codes_regenerated",
              userId: user.id,
              email: user.email,
              summary: disabled ? "Turned off two-factor authentication" : "Generated new backup codes",
            });
          }),
        },
        {
          // Permission changes made through Better Auth's organization routes.
          matcher: (ctx) => ORG_MEMBER_ACTIONS[ctx.path ?? ""] !== undefined,
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            if (!succeeded(ctx)) return;
            const session = ctx.context.session as (SessionData & { session: { activeOrganizationId?: string | null } }) | null | undefined;
            const returned = (ctx.context.returned ?? {}) as Record<string, unknown>;
            const record = (returned.member ?? returned) as { id?: string; email?: string; role?: string; organizationId?: string; userId?: string };
            const organizationId =
              record.organizationId ?? (typeof ctx.body?.organizationId === "string" ? ctx.body.organizationId : null) ?? session?.session.activeOrganizationId;
            if (!organizationId) return;
            const action = ORG_MEMBER_ACTIONS[ctx.path];
            await recordOrgEvent(prisma, {
              organizationId,
              actorId: session?.user.id ?? null,
              actorEmail: session?.user.email ?? null,
              action,
              targetType: action.startsWith("member.invit") ? "invitation" : "member",
              targetId: record.id ?? (typeof ctx.body?.memberId === "string" ? ctx.body.memberId : null),
              summary: orgEventSummary(action, record),
              metadata: { role: record.role ?? (ctx.body?.role as string | undefined) ?? null, email: record.email ?? null },
              ...requestContext(ctx.request),
            });
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/change-password",
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            const user = ctx.context.session?.user;
            if (user && succeeded(ctx)) await audit(ctx, { action: "auth.password_changed", userId: user.id, email: user.email, summary: "Changed password" });
          }),
        },
        {
          // An SSO sign-in only counts for people who belong to (or are invited to) the provider's workspace.
          matcher: (ctx) => (ctx.path ?? "").startsWith("/sso/callback"),
          handler: createAuthMiddleware(async (raw) => {
            const ctx = as(raw);
            const data = ctx.context.newSession;
            if (!data) return;
            const providerId = ctx.params?.providerId ?? callbackProviderId(ctx.request);
            const provider = providerId
              ? await prisma.ssoProvider.findUnique({ where: { providerId }, select: { organizationId: true } })
              : null;
            const allowed = provider?.organizationId
              ? await ssoAccessAllowed(prisma, provider.organizationId, data.user.id, data.user.email)
              : false;
            if (!allowed) {
              deleteSessionCookie(ctx as never, true);
              await ctx.context.internalAdapter.deleteSession(data.session.token);
              ctx.context.setNewSession(null);
              await audit(ctx, { action: "auth.sign_in_failed", userId: data.user.id, email: data.user.email, summary: "SSO sign-in refused: not a member of the workspace", metadata: { method: "sso" } });
              const target = new URL("/login", webUrl);
              target.searchParams.set("error", "sso_not_allowed");
              return ctx.redirect(target.toString());
            }
            if (data.user.twoFactorEnabled) return demandSecondFactor(ctx, data, webUrl);
            await audit(ctx, { action: "auth.sign_in", userId: data.user.id, email: data.user.email, summary: "Signed in with SSO", metadata: { method: "sso", providerId } });
          }),
        },
      ],
    },
  } as BetterAuthPlugin;
}

const ORG_MEMBER_ACTIONS: Record<string, string> = {
  "/organization/invite-member": "member.invited",
  "/organization/cancel-invitation": "member.invitation_cancelled",
  "/organization/update-member-role": "member.role_changed",
  "/organization/remove-member": "member.removed",
};

function orgEventSummary(action: string, record: { email?: string; role?: string }): string {
  switch (action) {
    case "member.invited":
      return `Invited ${record.email ?? "someone"} as ${record.role ?? "member"}`;
    case "member.invitation_cancelled":
      return `Cancelled the invitation for ${record.email ?? "someone"}`;
    case "member.role_changed":
      return `Changed a member's role to ${record.role ?? "unknown"}`;
    default:
      return "Removed a member from the workspace";
  }
}

/** The provider id from an `/sso/callback/:providerId` request URL. */
export function callbackProviderId(request: Request | undefined): string | undefined {
  if (!request) return undefined;
  const match = new URL(request.url).pathname.match(/\/sso\/callback\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** A member of the workspace, or someone with a pending invitation to it. */
export async function ssoAccessAllowed(
  prisma: Pick<PrismaService, "member" | "invitation">,
  organizationId: string,
  userId: string,
  email: string,
): Promise<boolean> {
  const member = await prisma.member.findFirst({ where: { organizationId, userId }, select: { id: true } });
  if (member) return true;
  return ssoInvitationExists(prisma, organizationId, email);
}

export async function ssoInvitationExists(
  prisma: Pick<PrismaService, "invitation">,
  organizationId: string,
  email: string,
): Promise<boolean> {
  const invitation = await prisma.invitation.findFirst({
    where: { organizationId, email: { equals: email, mode: "insensitive" }, status: "pending", expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return invitation !== null;
}

/**
 * Gate for the user.create hook: an account created by an SSO callback needs a
 * pending invitation to the provider's workspace, whatever ALLOW_SIGNUPS says.
 * Other routes return true here and keep the existing signup rules.
 */
export async function ssoSignUpAllowed(
  prisma: Pick<PrismaService, "invitation" | "ssoProvider">,
  email: string,
  ctx: { path?: string; params?: Record<string, string | undefined>; request?: Request } | null | undefined,
): Promise<boolean> {
  if (!ctx?.path?.startsWith("/sso/")) return true;
  const providerId = ctx.params?.providerId ?? callbackProviderId(ctx.request);
  if (!providerId) return false;
  const provider = await prisma.ssoProvider.findUnique({ where: { providerId }, select: { organizationId: true } });
  if (!provider?.organizationId) return false;
  return ssoInvitationExists(prisma, provider.organizationId, email);
}
