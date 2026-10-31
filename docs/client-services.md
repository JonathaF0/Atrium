# Client services: assets, contracts, announcements and the client dashboard

## Client companies

Atrium groups clients by their CRM **company** (Contacts → Companies). A portal client belongs to the company on their contact. On the company page you'll find:

- the company's contacts;
- its hourly support rate;
- its contracts, assets and client documentation.

Mark a client as **company admin** on their contact page to let them see everything for their company in the portal, not only what they requested themselves:

- tickets;
- estimates;
- billing plans;
- contracts.

Granting and revoking company admin is recorded in the audit log.

## Assets and licenses

**Assets** tracks what each client runs:

- devices, software licenses, domains, SSL certificates, cloud services and other items;
- vendor, model, serial number, who or where each is assigned, seats;
- purchase, warranty and renewal dates.

Assets marked client-visible appear under **Assets** in the portal for everyone at that company, without internal notes or metadata.

- **Import and export.** Import a CSV with column mapping; assets are matched on external ID, then serial number. Export to CSV; exports are audited.
- **Linking.** Assets can be linked to tickets.
- **Renewal alerts.** Every day, owners and admins get one digest of warranties and renewals coming up within `ASSET_RENEWAL_NOTICE_DAYS` (default 30). Licenses, certificates and domains past their date are marked expired.

### Syncing from an RMM or PSA

Connectors can push assets with an [API key](mcp.md#option-b-use-an-api-key):

```
PUT /api/assets/sync/<source>
Authorization: Bearer atr_…
Content-Type: application/json

{
  "fullSync": false,
  "assets": [
    { "externalId": "dev-123", "companyName": "Sample Client", "type": "device",
      "name": "Front desk PC", "vendor": "Example", "serialNumber": "SN-1",
      "warrantyEndsAt": "2027-03-01" }
  ]
}
```

What the sync endpoint accepts:

- `<source>` names the connector (lowercase letters, digits, `.`, `_`, `-`; `csv` is reserved).
- Each record is matched on `(source, externalId)` and up to 500 are accepted per request. Each record names its company by `companyId` or `companyName`.
- Fields you leave out keep their current value, and `null` clears a field.
- `fullSync: true` retires this source's assets that aren't in the batch; the batch must not be empty.
- Rows with problems come back in `errors` without failing the rest.

## Contracts and service agreements

**Contracts** records each client's agreements:

- type: MSA, SLA, retainer, block of hours or other;
- start and end dates, auto-renew, and a renewal notice period;
- included services and covered hours per month, quarter, year or term, plus an overage rate;
- an optional SLA policy and a link to the signed document.

How contracts are used:

- **Covered hours.** Periods are counted from the contract's start date. Time is counted against a contract either automatically (ticket time while hours remain) or by attaching entries from the contract page. Counted time is non-billable.
- **SLA.** A contract's SLA policy applies to that company's tickets, unless the ticket's category has its own policy.
- **Renewal reminders** go to owners and admins once per term, before the end date.
- **At the end date.** Auto-renewing contracts extend for the same length; others are marked expired. Both are recorded in the audit log.
- **Portal.** Company admins see their company's active contracts and remaining hours under **Contracts** in the portal.

## Announcements and service status

**Announcements** tell clients about news, planned maintenance, incidents and security advisories.

- **Audience.** One of:
  - all clients;
  - selected companies;
  - companies with an active contract of a given type or including a given service;
  - companies with an asset from a given vendor or of a given type.
  
  Clients without a company only receive announcements for all clients. Staff see the number of companies and recipients before sending.
- **Lifecycle.** Draft, scheduled (published automatically at a set time), published, and expired (automatically at an expiry time, or an hour after a maintenance window ends).
- **Incidents** are a timeline of dated updates (Investigating → Identified → Monitoring → Resolved). Resolved incidents move to history with an optional post-incident summary.
- **Delivery.**
  - Every announcement creates an in-app notification, which also gives the portal its unread badge.
  - Email and web push are opt-in per announcement.
  - Maintenance reminders go out `MAINTENANCE_REMINDER_HOURS` (default 24) before the window.
  - Slack, Discord and webhooks can subscribe to `announcement.published` and `announcement.updated`.
- **In the portal.**
  - Active incidents and upcoming maintenance show as a banner on the client dashboard.
  - **Announcements** lists everything with its timeline.
  - Clients can dismiss non-critical items; critical incidents stay until resolved.
  - New tickets in an affected category show the incident banner, so clients know it's already being handled.
- **Ticket links.** Staff can link tickets to an incident.
- **Templates** cover common notices (planned maintenance, outage, phishing alert, office closure), and every publish and edit is audited.

### Public status page

Off by default; owners turn it on in **Settings → Status page**. `/status/<workspace-slug>` then shows, without sign-in:

- active incidents;
- upcoming maintenance;
- the last 30 days of history;
- an RSS feed at `/api/status/<workspace-slug>/rss`.

Only announcements sent to all clients **and** marked "Show on the public status page" ever appear there.

## Client dashboard

Clients land on a dashboard showing:

- their open tickets and outstanding invoices;
- upcoming renewals (assets, plus contracts for company admins);
- recent project updates and the announcement banner;
- quick actions: new ticket, pay an invoice, help center, request work.

## Reports

**Reports** in the dashboard covers the following. Each report has a date range and company filter and exports to CSV; exports are audited.

- **Time**: hours by project, user and task.
- **Tickets**: created vs resolved, backlog, and breakdowns by category, priority, source and company.
- **SLA**: first-response and resolution compliance, and breached tickets.
- **Response times**: median and 90th percentile first response and resolution, in wall-clock hours.
- **Satisfaction**: average rating, response rate and comments.
- **Hours by client**: billable, non-billable and contract-covered hours against each contract's allowance, plus overage and un-invoiced time.
- **Revenue**: invoiced vs collected by month, receivables aging, recurring revenue (MRR) and the estimate pipeline.
