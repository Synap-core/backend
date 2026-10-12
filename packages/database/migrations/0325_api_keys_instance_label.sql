-- Migration: 0325_api_keys_instance_label.sql
--
-- One agent identity, several computers (2026-10-12): Claude Code on a laptop
-- and on a devbox share ONE agent user; each computer's key carries its own
-- `instance_id` (0204) — an opaque per-computer hash the CLI derives from the
-- OS machine id, so approving one computer's connection replaces only that
-- computer's key.
--
-- A hash is not something a person can recognise on an approval page. This
-- adds `api_keys.instance_label` (nullable text): the computer's human name as
-- the CLI sends it (`instanceLabel`, default the OS hostname without its
-- domain), so a connection reads "Claude Code — devbox". Display only — it
-- never scopes replacement (instance_id does). NULL = an older CLI.
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS instance_label text;
