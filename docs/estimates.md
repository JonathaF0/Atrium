# Estimates, catalog and recurring billing

## Service catalog

**Catalog** in the dashboard holds the services you sell. Each item has:

- a name and description;
- a category and unit;
- a billing type: hourly, fixed, or recurring (weekly, monthly, quarterly or yearly);
- a price, plus an internal cost that is never shown to clients;
- whether it is taxable.

**Bundles** group items, some of them optional, into packages such as "New workstation deployment" that you can drop into an estimate in one click.

Tax rates are managed in **Settings → Estimates**. One can be the default.

## Building an estimate

An estimate goes to a client company and one of its portal users, and can be linked to a project or a ticket. It has:

- line items from the catalog, from bundles, or written by hand. Each can be hourly, fixed or recurring, optional (the client decides), taxable with a tax rate, and have a decimal quantity;
- a discount (percent or amount), a deposit percentage, assumptions, exclusions, terms and a validity date. Terms and validity default from Settings → Estimates.

The builder shows live totals and, for staff only, the margin. Totals work like this:

- Optional items count only when selected.
- The discount applies to one-time items before tax.
- Recurring items are totalled separately per period.

Estimates are numbered `EST-1001`, `EST-1002`, … (the prefix is configurable). The PDF uses the same layout and branding as invoices.

## Sending, revising and expiry

| Status | Meaning |
|---|---|
| Draft | Being written; editable |
| Sent / Viewed | With the client |
| Changes requested | The client left comments; revise and resend |
| Accepted / Declined | The client responded |
| Expired | Past its validity date; can't be accepted |
| Superseded | A newer version was sent |
| Converted | Turned into a project and invoices |

**Revise** creates a new version with the same number. Sending it marks earlier versions superseded. Sent estimates expire automatically at their validity date, and the client gets one reminder before expiry (`ESTIMATE_REMINDER_DAYS`, default 3).

## What the client does

Under **Estimates** in the portal, the client can:

- view the estimate and download the PDF;
- toggle optional items;
- comment or request changes;
- decline with a reason;
- accept by typing their full name and drawing a signature.

Acceptance records the signer, time, IP address and browser in the estimate's history and in the [audit log](security.md#audit-log). Costs and margins are never sent to the client.

## Converting an accepted estimate

**Convert** runs once, in a single transaction, and creates:

- a project (or uses the linked one) with the client added;
- draft invoices, as one invoice for the full amount, a deposit invoice plus a balance invoice, or milestone invoices by percentage (adding up to 100%). Tax carries over line by line;
- a paused recurring invoice schedule for each billing interval of the recurring items. Review it and set it to active under **Recurring billing**;
- the signed estimate PDF, stored on the project as an accepted quote under **Documents**.

## AI-drafted estimates (optional)

Off by default. When `AI_ASSIST_ENABLED=true` and the workspace turns it on (Settings → Estimates), staff can ask for a draft from a description or a ticket. The draft includes a title, scope, assumptions and line items matched to your catalog. It is only a suggestion: nothing is saved or sent until someone reviews and saves it.

What is sent to the provider:

- the request text, or for a ticket its subject and public messages;
- your catalog's names and prices, but never costs.

Prompts are not logged. Any OpenAI-compatible endpoint works, including self-hosted models. See [configuration.md](configuration.md#environment-variables) for `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` and `AI_BASE_URL`.

## Tax on invoices

Invoice line items take an optional tax rate. Tax shows as its own line in totals, the PDF, CSV exports and Stripe Checkout. Invoices without tax look exactly as before.

## Recurring invoices and retainers

**Recurring billing** in the dashboard holds billing schedules for retainers and managed-services plans. Each schedule has:

- a client and recipient;
- items, which can carry tax;
- an interval (weekly, monthly, quarterly or yearly, every N periods);
- start and end dates, payment terms, and whether to send invoices automatically.

A job generates the invoices when they are due:

- **Interval dates.** Monthly dates stay on the start day; the 31st falls back to the end of shorter months.
- **First period.** With "prorate first period", the first invoice covers the start date to the next calendar boundary, priced by days.
- **Pausing.** Pausing and resuming skips missed periods rather than billing them.
- **Run now.** Generates the next invoice immediately.

**Auto-charge** is optional and off by default. The client saves a card from **Billing** in the portal through Stripe; generated invoices are then charged automatically, and staff are alerted if a charge fails. It needs online payments to be set up (see [stripe.md](stripe.md)).

**Overdue reminders** go out at the days set in `DUNNING_DAYS` (default 3, 7 and 14 days past due), once per stage. They also send an `invoice.overdue` integration event.

Clients see their active plans and all their invoices under **Billing** in the portal.
