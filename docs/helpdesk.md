# Helpdesk

Clients open support tickets in the portal or by email; your team works them from a queue with SLA timers, canned responses and automation. Staff pages are under **Tickets** and **Settings → Helpdesk**; clients use **Support** in the portal.

## Who sees what

- Staff (owners and admins) see every ticket in the workspace.
- A portal client sees the tickets they opened. Mark a client as **company admin** (on their contact page, or from a ticket) and they also see every ticket for their company. A company is the CRM company on the client's contact.
- Internal notes and internal events are never shown to clients or included in email.

## Tickets

Each ticket gets a number with a configurable prefix (default `TKT`, e.g. `TKT-1042`). Statuses:

| Status | Meaning | SLA clock |
|---|---|---|
| New | Not yet picked up | Running |
| Open | Being worked | Running |
| Waiting on client | Needs a reply from the client | Paused |
| Waiting on third party | Waiting on a vendor | Paused |
| On hold | Parked | Paused |
| Resolved | Fixed; the client can reopen or rate it | Stopped |
| Closed | Done | Stopped |

Clients pick a category and either a priority or an impact and urgency (high impact and high urgency gives Urgent). When a client replies to a ticket that is waiting on them, it moves back to Open.

Staff can:

- Work queue views (all, unassigned, mine, triage, SLA risk, open, closed) with filters and bulk actions: assign, change status or priority, add a label, close. Bulk actions take up to 100 tickets.
- Reply publicly or add internal notes, with attachments, and insert canned responses. Variables such as `{{requester.firstName}}`, `{{ticket.number}}` and `{{agent.name}}` are filled in.
- Merge tickets. Each merged ticket is closed and points at the target, and keeps its own messages. The target gets an internal note listing what was merged.
- Split a reply off into a new linked ticket, and link related tickets.
- Log time. Ticket time goes through the normal time tracking, so it shows up in "invoice from un-invoiced time". Tickets without a project log time to a per-company "Support — Company" project, created on first use. A company's hourly rate (on the company page) takes precedence over the project and member rates. If the company has a contract with covered hours remaining, new time is non-billable and counted against the contract.
- Convert a ticket into a project or a task, or turn a task or client request into a ticket.
- Draft a knowledge base article from a resolved ticket, link assets and announcements, and start an estimate from a ticket.

When a ticket is resolved or closed, clients can rate it from 1 to 5 with an optional comment. You can turn this off in settings.

## SLA policies and business hours

An SLA policy sets first-response and resolution targets for each priority, measured in the business hours of its calendar. Holidays are skipped. A ticket uses:

1. its category's policy,
2. otherwise the policy of the client company's active contract,
3. otherwise the workspace default.

The clock pauses while a ticket waits on the client or a third party, or is on hold, and due dates move out by the paused business time. A job runs every minute:

- at the policy's warning threshold (default 80%) it warns the assignee;
- on a breach it notifies the assignee, admins and the policy's escalation contact, and sends a `ticket.sla_breached` integration event.

## Automation

Rules run when a ticket is created or updated, in order. Each rule has conditions and actions:

- Conditions: category, priority, source, company, subject contains, status.
- Actions: set priority, assign, set category, add label, set status.

Example: "when category is Security, set priority High and assign to Sam". Rules don't trigger each other.

Also in Settings → Helpdesk:

- **Auto-acknowledge** emails the requester when a ticket arrives from the portal or by email.
- **Auto-close** closes resolved tickets after N days (default 7), and tickets waiting on the client after N days (off by default). It adds a system note.

## Email to ticket

Choose an inbound mode in **Settings → Helpdesk → Inbound email**.

**Webhook** (recommended). Have your mail provider or a small relay `POST` each message to:

```
https://<API_URL>/api/helpdesk/inbound/<workspace-slug>
```

with a JSON body and two headers:

- `X-Atrium-Timestamp`: Unix seconds; must be within 5 minutes of the server's clock.
- `X-Atrium-Signature: sha256=<hex>`: HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the workspace's inbound secret.

The secret is generated in settings and shown once; rotate it there. The body carries `messageId`, `from`, `subject`, `text`, optional `html`, `inReplyTo`, `references` and `attachments`, or a `raw` field holding the base64 RFC 822 message. Requests with a bad or stale signature are refused.

**IMAP**. Atrium polls a mailbox every minute. The password is stored encrypted. Use **Test connection** in settings to check the details.

How messages are handled:

- **Threading.** Outgoing ticket email has the subject `[TKT-1042] Subject`, a reply-to address carrying the ticket's private token (`support+<token>@…`), and the token in the footer. Replies are matched by `In-Reply-To`/`References`, then by the token. A bare ticket number is never trusted.
- **Known senders.** A client with a portal login gets the ticket on their behalf. A contact without a login gets a ticket but no portal access.
- **Unknown senders** go to the **triage** queue. They never get an account or portal access; staff accept a triage ticket by assigning it to a contact.
- **Other cases.** Auto-replies and bulk mail are ignored. Quoted reply text is stripped. Mail on a thread from someone other than the requester or their company becomes an internal note. A reply to a closed ticket opens a new linked ticket.

Set **Inbound address** to the address clients write to. Ticket emails then use it as the reply-to address.

## Notifications and integrations

Staff get in-app, push and email notifications for new tickets, client replies and assignments. Requesters get email and in-app notifications for public replies and status changes. Slack, Discord and webhook destinations can subscribe to `ticket.created`, `ticket.replied`, `ticket.status_changed`, `ticket.assigned` and `ticket.sla_breached`.

## MCP tools

`list_tickets`, `get_ticket`, `add_ticket_note`, `reply_to_ticket` and `update_ticket` let an assistant work tickets, and the knowledge base tools let it look up articles while doing so. See [mcp.md](mcp.md).
