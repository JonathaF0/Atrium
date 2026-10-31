# Configuration

## Environment Variables

All configuration lives in a single `.env` file. See [`.env.example`](../.env.example) for the full list.

### Required

| Variable | Description |
|---|---|
| `BETTER_AUTH_SECRET` | Random string, at least 32 characters, for signing sessions |
| `WEB_URL` | The address people open Atrium at, e.g. `https://atrium.example.com`. Used for sign-in, CORS and every link in email. See [docker.md](docker.md#public-url) |
| `DATABASE_URL` | PostgreSQL connection string. The Docker image starts its own database when this is unset |

That's all you need. Everything below is optional.

### Optional

**File storage**

| Variable | Default | Description |
|---|---|---|
| `STORAGE_PROVIDER` | `local` | File storage backend: `local`, `s3`, `minio`, `r2` |
| `UPLOAD_DIR` | `./uploads` | Local upload directory (when using local storage) |
| `S3_ENDPOINT` | -- | S3-compatible endpoint (for MinIO/R2) |
| `S3_REGION` | `us-east-1` | AWS region |
| `S3_BUCKET` | `atrium` | Bucket name |
| `S3_ACCESS_KEY` | -- | S3 access key |
| `S3_SECRET_KEY` | -- | S3 secret key |
| `MAX_FILE_SIZE_MB` | `50` | Maximum upload size in megabytes |

**Email**

| Variable | Default | Description |
|---|---|---|
| `RESEND_API_KEY` | -- | Resend API key for transactional email |
| `EMAIL_FROM` | `noreply@atrium.local` | Sender address for outbound email |

**Other**

| Variable | Default | Description |
|---|---|---|
| `MCP_OAUTH_ENABLED` | `true` | Allow MCP clients to connect by signing in (OAuth). Requires a public HTTPS URL. API keys work regardless |
| `BILLING_ENABLED` | -- | Set to `true` to enable billing/plan gates (hosted only) |
| `LOG_LEVEL` | `info` | Pino log level |

**Upload scanning**

Ticket, knowledge base and client documentation uploads are always checked against the extension blocklist, the size limit and their real content type (a renamed executable or an HTML/SVG file is refused). Set `CLAMAV_HOST` to also scan them with ClamAV.

| Variable | Default | Description |
|---|---|---|
| `CLAMAV_HOST` | -- | Host of a `clamd` daemon (TCP). Unset = no malware scanning |
| `CLAMAV_PORT` | `3310` | `clamd` port |
| `CLAMAV_TIMEOUT_MS` | `30000` | Scan timeout |
| `CLAMAV_REQUIRED` | `false` | `true` refuses uploads when the scanner can't be reached, instead of accepting them unscanned |

**Estimates and AI assist**

| Variable | Default | Description |
|---|---|---|
| `ESTIMATE_REMINDER_DAYS` | `3` | Days before an estimate expires that the client gets a reminder; `0` turns reminders off |
| `AI_ASSIST_ENABLED` | -- | Set to `true` to allow AI-drafted estimates. Each workspace must also turn it on in Settings → Estimates. Drafts are suggestions only and are never saved or sent without review |
| `AI_PROVIDER` | `anthropic` | `anthropic`, or `openai` for any OpenAI-compatible server (including self-hosted models) |
| `AI_API_KEY` | -- | Provider API key. Optional for a self-hosted OpenAI-compatible server |
| `AI_MODEL` | -- | Model name. Required when AI assist is on |
| `AI_BASE_URL` | provider default | Override the API address, e.g. a self-hosted endpoint |
| `AI_TIMEOUT_MS` | `45000` | Request timeout (max `120000`) |

**Billing reminders and renewals**

| Variable | Default | Description |
|---|---|---|
| `DUNNING_DAYS` | `3,7,14` | Days past due on which overdue invoice reminders go out. Empty, `0` or `off` disables them |
| `ASSET_RENEWAL_NOTICE_DAYS` | `30` | Days before an asset's warranty or renewal date that owners and admins are notified |
| `MAINTENANCE_REMINDER_HOURS` | `24` | Hours before a maintenance window that the audience gets a reminder |

**Security**

| Variable | Default | Description |
|---|---|---|
| `SSO_ENABLED` | -- | Set to `true` to let owners configure OpenID Connect single sign-on for their workspace. See [security.md](security.md#single-sign-on) |
| `TWO_FACTOR_ISSUER` | `Atrium` | Name authenticator apps show for two-factor codes |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | Days audit log entries are kept; `0` keeps them forever |

> **Upgrading from v1.3 or earlier?** `BETTER_AUTH_URL` has been renamed to `API_URL`. The old name still works as a fallback but will be removed in a future release.

### Required for split deployments

The Docker image runs the web app and API in one container and sets these for you. If you run them separately (`docker/web.Dockerfile` and `docker/api.Dockerfile`, or on different servers), set all three:

| Variable | Set on | Example | Description |
|---|---|---|---|
| `API_URL` | API | `https://api.example.com` | The API's public address, used in sign-in, OAuth, Stripe webhook and email logo links |
| `INTERNAL_API_URL` | Web | `http://atrium-api:3001` | The API's private address, used when the web app renders pages. Never sent to browsers. The web app refuses to start without it |
| `NEXT_PUBLIC_API_URL` | Web, at build time | `https://api.example.com` | The address browsers use. Leave empty when the API is on the same origin as the app |

## Storage Providers

Set `STORAGE_PROVIDER` in your `.env`:

- **`local`** -- Files saved to `UPLOAD_DIR`. Default for development.
- **`s3`** -- Amazon S3. Set `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_REGION`.
- **`minio`** -- Self-hosted S3-compatible storage. Set `S3_ENDPOINT` and credentials.
- **`r2`** -- Cloudflare R2. Set `S3_ENDPOINT`, `S3_BUCKET`, and credentials.
