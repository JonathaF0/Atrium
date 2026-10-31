# Knowledge base

Write help articles and internal runbooks, publish them to clients, and keep per-client documentation. Staff use **Knowledge base** in the dashboard; clients use **Help center** and **Documentation** in the portal.

## Collections and visibility

Articles live in collections, which can be nested. Articles and collections each have a visibility:

| Visibility | Who can read it |
|---|---|
| Public | Everyone, including the public help center when it is turned on |
| All clients | Every portal client of the workspace |
| Selected clients | Portal clients whose company is in the article's or collection's audience |
| Staff only | Owners and admins (runbooks, internal procedures) |

An article's effective visibility is the strictest of its own setting and every collection above it. When several layers are restricted to selected clients, a reader must be admitted by all of them. Only published articles are shown outside the dashboard. The same rules apply to listing, search, related articles, suggestions, attachments and the MCP tools, so an article you can't read never shows up even as a title.

## Writing and publishing

- Articles are markdown, with a toolbar, live preview, image and file uploads, tags (workspace labels), an owner and a "review by" date.
- Workflow: Draft → In review → Published → Archived. Any owner or admin can publish; "In review" signals that an article is ready but doesn't block publishing.
- Saving a published or in-review article creates a new version. Earlier versions can be viewed and restored; restoring creates a new version.
- Publishing, unpublishing, archiving, deleting and changing visibility or audiences are recorded in the [audit log](security.md#audit-log).
- Article owners get a daily digest of their articles that are past their review date. New articles default to a review date 180 days out, configurable on the Knowledge base page.

The sample content (Settings → General → Sample content, or `bun run db:seed:samples`) adds starter collections and draft articles you can edit or delete.

## Reading

Clients can:

- browse collections and search full-text, ranked by relevance with a title match for short queries;
- open related articles;
- answer "Was this helpful?" with one vote per person, which can be changed.

View counts are counted at most once per reader per article per day. This is tracked in memory on each API instance, so a restart or a second instance can occasionally add one extra view.

## Helpdesk integration

- While a client types a ticket subject, matching articles are suggested under the field. Opening one, or leaving without submitting the ticket, is recorded as a deflection; the stats page shows which articles prevent tickets.
- Staff can insert an article link into a reply.
- Staff can draft an article from a resolved ticket. The draft uses the subject and the public messages; internal notes and email addresses are left out.

## Public help center

Off by default. Turn it on from the Knowledge base page; public articles are then readable without signing in at `/help/<workspace-slug>`, using your workspace branding. Anonymous "helpful" votes are keyed by a salted hash of IP and browser, and neither is stored.

## Client documentation

Each client company has a **Documentation** section on its company page for:

- network diagrams;
- onboarding notes;
- runbooks;
- vendor and contact lists;
- licenses and renewals.

Every portal user of that company sees the documents marked visible to the client under **Documentation** in the portal; staff-only documents stay internal.

**Never store passwords here.** Link to the entry in your password vault instead (the vault link must be `https://`). Documents that look like they contain credentials are refused, such as `password: …`, `token = …`, private key blocks, or URLs with a username and password.

## MCP

`search_kb_articles`, `get_kb_article` and `list_kb_collections` let an AI assistant look articles up, for example while helping with a ticket. Staff-only articles are included unless the tool is asked for client-visible results only. See [mcp.md](mcp.md).
