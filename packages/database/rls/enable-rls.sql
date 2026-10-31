-- =============================================================================
-- Enable Row Level Security on all Atrium tables
-- =============================================================================
-- This script is IDEMPOTENT -- safe to run multiple times.
--
-- Purpose: Lock down Supabase's PostgREST surface. The `anon` and
-- `authenticated` roles lose all direct table access. The `postgres`
-- superuser (used by Prisma / the API) bypasses RLS automatically.
--
-- No permissive policies are created, so even if RLS is enabled, the
-- anon/authenticated roles have zero access through PostgREST.
-- =============================================================================

BEGIN;

-- ─── Enable RLS on every table ──────────────────────────────────────────────
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY is a no-op if already enabled.
-- Every table in schema.prisma must be listed here (enforced by enable-rls.spec.ts).

ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_key" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_access_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_consent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_pending_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_client" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "file" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_update" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_option" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_vote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_line_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "system_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_status" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_response" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_field" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_audit_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_access_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_plan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activity_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "file_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_source" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_contact_gap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "time_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_destination" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canned_response" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sla_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_holiday" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbound_email" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_collection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_article" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_article_revision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_audience" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_article_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_deflection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kb_attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_doc" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_doc_attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tax_rate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_bundle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_bundle_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate_line_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate_comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_invoice_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_asset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "announcement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "announcement_update" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "announcement_audience" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "announcement_dismissal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "announcement_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_announcement" ENABLE ROW LEVEL SECURITY;

-- ─── Revoke direct access from anon and authenticated roles ─────────────────
-- REVOKE is idempotent -- revoking a privilege that was never granted is a no-op.

REVOKE ALL ON "user" FROM anon, authenticated;
REVOKE ALL ON "session" FROM anon, authenticated;
REVOKE ALL ON "account" FROM anon, authenticated;
REVOKE ALL ON "verification" FROM anon, authenticated;
REVOKE ALL ON "organization" FROM anon, authenticated;
REVOKE ALL ON "member" FROM anon, authenticated;
REVOKE ALL ON "invitation" FROM anon, authenticated;
REVOKE ALL ON "api_key" FROM anon, authenticated;
REVOKE ALL ON "oauth_application" FROM anon, authenticated;
REVOKE ALL ON "oauth_access_token" FROM anon, authenticated;
REVOKE ALL ON "oauth_consent" FROM anon, authenticated;
REVOKE ALL ON "mcp_grant" FROM anon, authenticated;
REVOKE ALL ON "mcp_pending_grant" FROM anon, authenticated;
REVOKE ALL ON "project" FROM anon, authenticated;
REVOKE ALL ON "project_client" FROM anon, authenticated;
REVOKE ALL ON "file" FROM anon, authenticated;
REVOKE ALL ON "project_update" FROM anon, authenticated;
REVOKE ALL ON "task" FROM anon, authenticated;
REVOKE ALL ON "decision_option" FROM anon, authenticated;
REVOKE ALL ON "decision_vote" FROM anon, authenticated;
REVOKE ALL ON "comment" FROM anon, authenticated;
REVOKE ALL ON "invoice" FROM anon, authenticated;
REVOKE ALL ON "invoice_line_item" FROM anon, authenticated;
REVOKE ALL ON "project_note" FROM anon, authenticated;
REVOKE ALL ON "client_profile" FROM anon, authenticated;
REVOKE ALL ON "branding" FROM anon, authenticated;
REVOKE ALL ON "system_settings" FROM anon, authenticated;
REVOKE ALL ON "project_status" FROM anon, authenticated;
REVOKE ALL ON "document" FROM anon, authenticated;
REVOKE ALL ON "document_version" FROM anon, authenticated;
REVOKE ALL ON "document_response" FROM anon, authenticated;
REVOKE ALL ON "signature_field" FROM anon, authenticated;
REVOKE ALL ON "document_audit_event" FROM anon, authenticated;
REVOKE ALL ON "document_access_token" FROM anon, authenticated;
REVOKE ALL ON "subscription_plan" FROM anon, authenticated;
REVOKE ALL ON "subscription" FROM anon, authenticated;
REVOKE ALL ON "notification" FROM anon, authenticated;
REVOKE ALL ON "push_subscription" FROM anon, authenticated;
REVOKE ALL ON "activity_log" FROM anon, authenticated;
REVOKE ALL ON "label" FROM anon, authenticated;
REVOKE ALL ON "project_label" FROM anon, authenticated;
REVOKE ALL ON "task_label" FROM anon, authenticated;
REVOKE ALL ON "file_label" FROM anon, authenticated;
REVOKE ALL ON "member_label" FROM anon, authenticated;
REVOKE ALL ON "company" FROM anon, authenticated;
REVOKE ALL ON "lead_source" FROM anon, authenticated;
REVOKE ALL ON "contact" FROM anon, authenticated;
REVOKE ALL ON "contact_note" FROM anon, authenticated;
REVOKE ALL ON "contact_event" FROM anon, authenticated;
REVOKE ALL ON "contact_label" FROM anon, authenticated;
REVOKE ALL ON "project_contact" FROM anon, authenticated;
REVOKE ALL ON "project_contact_gap" FROM anon, authenticated;
REVOKE ALL ON "time_entry" FROM anon, authenticated;
REVOKE ALL ON "integration_destination" FROM anon, authenticated;
REVOKE ALL ON "integration_delivery" FROM anon, authenticated;
REVOKE ALL ON "audit_log" FROM anon, authenticated;
REVOKE ALL ON "service_settings" FROM anon, authenticated;
REVOKE ALL ON "ticket_category" FROM anon, authenticated;
REVOKE ALL ON "ticket" FROM anon, authenticated;
REVOKE ALL ON "ticket_message" FROM anon, authenticated;
REVOKE ALL ON "ticket_attachment" FROM anon, authenticated;
REVOKE ALL ON "ticket_event" FROM anon, authenticated;
REVOKE ALL ON "ticket_link" FROM anon, authenticated;
REVOKE ALL ON "ticket_label" FROM anon, authenticated;
REVOKE ALL ON "canned_response" FROM anon, authenticated;
REVOKE ALL ON "sla_policy" FROM anon, authenticated;
REVOKE ALL ON "business_hours" FROM anon, authenticated;
REVOKE ALL ON "business_holiday" FROM anon, authenticated;
REVOKE ALL ON "automation_rule" FROM anon, authenticated;
REVOKE ALL ON "inbound_email" FROM anon, authenticated;
REVOKE ALL ON "kb_collection" FROM anon, authenticated;
REVOKE ALL ON "kb_article" FROM anon, authenticated;
REVOKE ALL ON "kb_article_revision" FROM anon, authenticated;
REVOKE ALL ON "kb_audience" FROM anon, authenticated;
REVOKE ALL ON "kb_article_label" FROM anon, authenticated;
REVOKE ALL ON "kb_feedback" FROM anon, authenticated;
REVOKE ALL ON "kb_deflection" FROM anon, authenticated;
REVOKE ALL ON "kb_attachment" FROM anon, authenticated;
REVOKE ALL ON "client_doc" FROM anon, authenticated;
REVOKE ALL ON "client_doc_attachment" FROM anon, authenticated;
REVOKE ALL ON "tax_rate" FROM anon, authenticated;
REVOKE ALL ON "catalog_item" FROM anon, authenticated;
REVOKE ALL ON "catalog_bundle" FROM anon, authenticated;
REVOKE ALL ON "catalog_bundle_item" FROM anon, authenticated;
REVOKE ALL ON "estimate" FROM anon, authenticated;
REVOKE ALL ON "estimate_line_item" FROM anon, authenticated;
REVOKE ALL ON "estimate_event" FROM anon, authenticated;
REVOKE ALL ON "estimate_comment" FROM anon, authenticated;
REVOKE ALL ON "recurring_invoice" FROM anon, authenticated;
REVOKE ALL ON "recurring_invoice_item" FROM anon, authenticated;
REVOKE ALL ON "asset" FROM anon, authenticated;
REVOKE ALL ON "ticket_asset" FROM anon, authenticated;
REVOKE ALL ON "contract" FROM anon, authenticated;
REVOKE ALL ON "announcement" FROM anon, authenticated;
REVOKE ALL ON "announcement_update" FROM anon, authenticated;
REVOKE ALL ON "announcement_audience" FROM anon, authenticated;
REVOKE ALL ON "announcement_dismissal" FROM anon, authenticated;
REVOKE ALL ON "announcement_template" FROM anon, authenticated;
REVOKE ALL ON "ticket_announcement" FROM anon, authenticated;

COMMIT;
