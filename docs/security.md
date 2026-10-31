# Security

Atrium ships with production-grade security defaults:

- Helmet CSP restricting scripts, styles, images, and connections to `'self'`
- CORS locked to a single origin (`WEB_URL`) with credentials
- Global rate limiting (100 requests/min) via `@nestjs/throttler`
- `ValidationPipe` with `whitelist` and `forbidNonWhitelisted` on all endpoints
- Auth guard + roles guard on all non-public routes
- Global exception filter that hides stack traces from clients
- File upload sanitization with blocked dangerous extensions
- Non-root Docker containers
- Required env var validation at startup

## API keys

API keys (`atr_…`) are generated from 32 random bytes and stored only as SHA-256 hashes.
A key is bound to one membership (user + organization) and resolves only while that user
is an owner or admin there. Removing the member deletes its keys and MCP grants (both
cascade from `member`, whichever route removes it, including Better Auth's own
`/organization/leave`), and a re-added user gets a new member row that none of the old
credentials point at. Demotion below admin revokes the keys and deletes the grants in the
same transaction as the role change (or in Better Auth's `afterUpdateMemberRole` hook for
its own endpoint), so a later re-promotion does not revive them. Keys are ignored when a session cookie is present, cannot create
or revoke other keys, and are revocable from Settings → Integrations. Resolved keys are
cached for 30 seconds, in a map the cookie-session path never reads, so a stored key
hash cannot be replayed as a session token. The MCP endpoint is rate limited to 300
requests per minute per key (per user for OAuth tokens), returning `429` with `Retry-After: 60`. Failed key lookups
(invalid or revoked) are limited to 30 per minute per client IP in `SessionMiddleware`,
before the database is touched; once an IP is limited, MCP answers `429` and the REST API
answers `401`. Per-IP limits assume the reverse proxy overwrites `X-Forwarded-For` with
the real client address: `trust proxy` is on, so a passed-through client value would let
an attacker vary the bucket.

## MCP OAuth

Atrium acts as an OAuth 2.1 authorization server for MCP clients (Better Auth `mcp`
plugin): PKCE with S256 is required (the `plain` method is refused), redirect URIs are
exact-match, access tokens last 1 hour and refresh tokens 30 days. Dynamic client
registration is open, as the MCP spec expects; it refuses redirect URIs that are
unparseable, contain a comma, or use the `javascript:`, `data:`, `vbscript:`, `blob:`,
`file:`, or `about:` schemes (checked again at authorize time), is rate limited to 10
per hour per IP, and unused registrations are pruned after 7 days.

An authorization code cannot be exchanged before the user has pressed Allow. In this
Better Auth version the consent code *is* the authorization code, and the token endpoint
checks only that the code exists and has not expired, so Atrium checks the code's own
`requireConsent` flag first and answers `400 invalid_grant` until consent has actually
been given. The token endpoint also accepts a JSON body of any shape and coerces the
presented code with `toString()`, so the check coerces it identically -- a code wrapped
in an array or sent as a number is refused just the same.

OAuth access tokens are honoured **only** on `POST /api/mcp` (with or without a trailing
slash -- both reach the same route), and only when they arrive as a bearer token: a
browser session cookie does not authenticate that endpoint, so a logged-in user cannot be
made to drive it from another site. The `Bearer` scheme is matched case-insensitively,
per RFC 7235. Tokens cannot call the REST API, and API keys cannot create or remove MCP
grants -- both require a dashboard session. Each grant is bound to one workspace, chosen
on the consent screen, and resolves only while the user is an owner or admin there.

The workspace choice takes effect only once consent succeeds. The consent screen records
the chosen workspace against the consent code before it submits the approval
(`mcp_pending_grant`), and that parked choice grants nothing on its own: the grant is
written afterwards by a server-side hook, only once the plugin's consent endpoint has
returned successfully, in the same transaction that clears the parked row. Abandoning the
consent page -- or a consent that fails -- therefore leaves any existing connection
exactly as it was. When a
completed consent does move a client to a different workspace, that client's older tokens
are deleted in that transaction, so a session authorized for the previous workspace is
signed out rather than silently moved. Parked choices whose consent code has expired are
deleted nightly.

The endpoint refuses JSON-RPC batches (`400`, error `-32600`). The current MCP spec has
no batching, and the per-key rate limit counts HTTP requests, so one request carrying an
array of calls would have spent a single token and run all of them.

The plugin stores access **and refresh** tokens unhashed. A database leak therefore
exposes refresh tokens that stay redeemable for 30 days, and MCP clients are public
clients that refresh with `client_id` alone -- no secret is involved. The
single-endpoint rule, not the access token's one-hour lifetime, is what bounds the
impact. The plugin's own `GET /api/auth/mcp/get-session` endpoint, which returns the
whole token row (refresh token included) for any presented access token, is blocked and
answers 404. Token rows whose refresh window has closed are deleted nightly.

Disconnecting an app deletes its tokens and workspace grant; because of the 30-second
auth cache, a token can keep working for up to 30 seconds after disconnect or expiry.
The recorded consent is kept on purpose -- it grants nothing, but it marks the
registration as one a person approved, so the nightly prune of abandoned registrations
leaves it in place and the client can reconnect by signing in again instead of failing
with `invalid_client`.

Setting `MCP_OAUTH_ENABLED="false"` unmounts the OAuth endpoints *and* stops honouring
access tokens that were already issued, so turning the feature off disconnects existing
clients immediately rather than an hour later.

Better Auth's own rate limiter -- including the 10-per-hour rule on dynamic client
registration -- is active only when `NODE_ENV=production`. The application's other
limits (the global throttler, the per-key MCP limit, the failed-key limiter) apply in
every environment.

Because registration is anonymous, the consent screen shows a client-chosen name --
so it also shows where approving will send you, read from the pending request itself.
Only approve a connection you started yourself. Review and disconnect apps anytime
under Settings → Integrations → Connected apps.

## Two-factor authentication

Staff and clients can turn on two-factor authentication (an authenticator app, plus single-use backup codes) under their account settings. Owners can require it in **Settings → General → Security** for staff only or for everyone; an owner must enrol before turning it on. Until a user it applies to enrols, every API route except sign-in, account and enrolment answers `403` with `error: "TWO_FACTOR_REQUIRED"`, and the app sends them to the enrolment page. API keys and MCP tokens are not affected; they already resolve only for owners and admins.

Magic-link and SSO sign-ins for a user with two-factor turned on still ask for a code: the sign-in becomes the same pending challenge a password sign-in gets.

## Single sign-on

With `SSO_ENABLED=true`, owners can connect an OpenID Connect provider for their workspace (Settings → General → Security). The issuer must be a public `https://` URL. The client secret is stored encrypted. The email domain must be proven with a DNS TXT record (`_atrium-sso.<domain>`) before anyone can sign in through it. Shared mail domains, and domains already used by another workspace, are refused.

SSO never grants access on its own:

- New accounts are created only for people with a pending invitation to that workspace, whatever `ALLOW_SIGNUPS` says.
- Existing users must already be members or invitees.

SAML is not offered.

## Client data isolation

Portal clients only ever see:

- their own records;
- their company's records, when they are a company admin;
- what is explicitly shared with their company: client-visible assets, client documentation, and knowledge base articles and announcements whose audience includes them.

The company always comes from the signed-in user's own contact, never from an id sent by the browser. Staff-only fields (internal notes, ticket events, catalog costs, estimate margins, asset metadata) are never included in portal responses.

## Uploads

Ticket, knowledge base and client documentation attachments are:

- checked against the workspace's size limit and the blocked-extension list;
- checked against their declared type, so a renamed executable or an HTML/SVG file is refused;
- optionally scanned with ClamAV (`CLAMAV_HOST`).

They are served with `X-Content-Type-Options: nosniff` and downloaded as attachments, except common image types. Markdown in tickets, articles and announcements is rendered without raw HTML and sanitised, and links open with `rel="noopener noreferrer nofollow"`.

## Inbound email

The email-to-ticket webhook is public but accepts only requests signed with the workspace's secret (HMAC-SHA256 over the timestamp and raw body, compared in constant time, with a 5-minute window). It is rate limited. Mail from unknown senders lands in a triage queue and never creates an account or portal access. The IMAP password and webhook secret are stored encrypted.

## Audit log

**Settings → Audit log** lists sensitive actions with who, when, IP address and browser, and can be filtered and exported to CSV (the export is itself logged). Recorded actions include:

- sign-ins, failed sign-ins, sign-outs, password resets and two-factor changes;
- role changes, member removals, invitations and company admin changes;
- every CSV export;
- invoice status changes, payments, Stripe connection changes and plan changes;
- helpdesk merges, splits, deletions, bulk actions and settings;
- knowledge base publishing and visibility changes;
- estimate sends, acceptances and conversions;
- contract renewals, announcement publishing, and sample content loads.

Entries are kept for `AUDIT_LOG_RETENTION_DAYS` (default 365; `0` keeps them forever).
