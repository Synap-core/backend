-- Migration 0041: A2AI channel type
--
-- Adds the "a2ai" (agent-to-agent) channel type.
--
-- The channels.channel_type column is TEXT (not a native PG enum),
-- so no ALTER TYPE is needed. This migration just documents the new
-- valid value and adds an optional check constraint for DB-level enforcement.
--
-- A2AI channels are used for async peer communication between AI agents
-- (e.g., Synap IS <-> OpenClaw). No human author is required.
-- Metadata stores:
--   metadata.topic        string  — collaboration subject
--   metadata.visibility   "open"|"closed"
--   metadata.participants string[] — agent user IDs (for closed channels)
--
-- Humans can observe and inject messages into A2AI channels.

-- No structural changes needed — channel_type is already TEXT.
-- Adding a comment as documentation only.
COMMENT ON COLUMN channels.channel_type IS
  'Valid values: ai_thread, branch, entity_comments, document_review, view_discussion, direct, external_import, a2ai';
