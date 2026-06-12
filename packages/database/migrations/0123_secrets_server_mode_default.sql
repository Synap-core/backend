-- 0123_secrets_server_mode_default.sql
-- Server-only vault consolidation: secrets are now encrypted server-side by default.
--
-- Rationale: on a sovereign pod the server already holds all data in plaintext, and
-- AI credential grants (grantAIAccess) require server-readable secrets. The prior
-- 'client' (zero-knowledge) mode forced dual code paths and blocked the agent flow.
--
-- This only changes the DEFAULT for NEW rows. Existing 'client'-mode rows on other
-- pods are left untouched (read tolerance) — they remain listable/gettable but can no
-- longer be granted to AI and are never written again.

ALTER TABLE secrets ALTER COLUMN encryption_mode SET DEFAULT 'server';
