# Inviting clients from a CRM

When a lead becomes a client in your CRM, Atrium can send them the portal invitation automatically. The CRM calls one endpoint with an [API key](mcp.md#option-b-use-an-api-key); Atrium fills in the contact and company and emails the same invitation as **Invite to portal** on the contact page.

## The endpoint

```
POST /api/clients/invite
Authorization: Bearer atr_…
Content-Type: application/json

{
  "email": "lee@example.com",
  "firstName": "Lee",
  "lastName": "Park",
  "company": "Sample Recovery",
  "phone": "555-0100",
  "jobTitle": "Office manager",
  "externalId": "00Q5e00000AbCdE"
}
```

Only `email` is required. On success it answers `200` with:

```json
{ "status": "invited", "contactId": "…", "companyId": "…", "invitationId": "…", "emailSent": true }
```

| `status` | Meaning |
|---|---|
| `invited` | A new invitation was created and emailed |
| `already_invited` | An unexpired invitation is already pending; nothing was sent. Pass `"resend": true` to send a fresh one |
| `already_client` | The person already has portal access; nothing was sent |

How it works:

- **The contact.** It is matched by email or created, and the company is matched by name (ignoring case) or created. The contact's status becomes Client.
- **Existing details are kept.** Details staff already entered are never overwritten; the endpoint only fills in fields that are empty.
- **Portal access only.** The client isn't added to any project. Add them to projects from the contact page whenever you're ready.
- **Email not sent.** `emailSent` is `false` when no email provider is configured or the provider refused the message. The invitation still exists, and its link can be copied from the contact page.
- **Audit log.** Every invitation is recorded with the API key's owner as the actor and `externalId` in its details.
- **Refusals.** An email that belongs to a staff member gets `409`. A request without a valid owner or admin key gets `401`, and a portal client's session gets `403`. The endpoint allows 60 requests per minute.

## Salesforce setup

This uses a record-triggered Flow, so no Apex code is needed.

1. **Create an API key in Atrium.** In Settings → Integrations, create a key named e.g. "Salesforce". Copy it; it is shown once.
2. **Store the key in Salesforce.** In Setup → Named Credentials:
   1. Create an External Credential with the **Custom** authentication protocol and a principal holding a parameter, e.g. `Key`, set to the API key.
   2. Add a custom header `Authorization` with the value `{!'Bearer ' & $Credential.AtriumApi.Key}`, where `AtriumApi` is your External Credential's name.
   3. Create a Named Credential with the URL of your portal, e.g. `https://portal.example.com`, using that External Credential.
   4. Give your users' permission set access to the External Credential principal.
3. **Register the endpoint.** In Setup → External Services, add a new service from the Named Credential. Define one operation: `POST /api/clients/invite`, with a JSON body made of the fields above and the JSON response shown above. Alternatively, use a Flow **HTTP Callout** action and enter the same details there.
4. **Build the Flow.** Create a Record-Triggered Flow on **Lead**:
   - trigger when a record is updated, with the condition `Status` equals `Converted`, or `IsConverted` equals true if you use Salesforce's Convert button;
   - set it to run only when the record is updated to meet the condition;
   - choose **Run asynchronously**, which callouts require;
   - add a Decision so leads without an email are skipped;
   - call the action, mapping `Email`, `FirstName`, `LastName`, `Company`, `Phone`, `Title` → `jobTitle`, and `Id` → `externalId`.
5. **Test it.** Convert a test lead with your own email address. The invitation should arrive, and the contact appears under Contacts with portal access pending.

The endpoint is idempotent, so a Flow that fires twice, or a lead converted again later, doesn't send a second invitation while the first is pending.

The same endpoint works from any system that can make an HTTP request: HubSpot workflows, Zapier, n8n, or a script.
