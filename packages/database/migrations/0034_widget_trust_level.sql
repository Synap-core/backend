-- 0034_widget_trust_level.sql
--
-- View Trust + Capability Model (Phase 1).
--
-- Adds the server-side trust authority for framed views. A view-originated
-- write resolves its trust from this column (keyed by type_key + workspace_id)
-- — never from the request body. Default is the most conservative level
-- ("generated") so an existing or unspecified row always PROPOSES rather than
-- writing directly. Trust is elevated only by a human-approved install/publish.

ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "trust_level" text NOT NULL DEFAULT 'generated';
