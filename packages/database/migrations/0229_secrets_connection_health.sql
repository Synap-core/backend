-- Migration: 0229_secrets_connection_health.sql
--
-- Connection health mirror on the capability-connection registry (which IS the
-- `secrets` table — connection rows are stamped `capability_id`).
--
-- WHY: the capability catalog derived "connected" purely from a connection
-- EXISTING in Nango's list — it never saw an expired/revoked OAuth token, so a
-- dead connection read "connected" and its verbs 500'd at run time. The
-- `"expired"` state the catalog already declared was never computed. These
-- columns let this pod MIRROR the broker's (Nango's) credential health so the
-- catalog reads ONE store (secrets) for both existence AND health.
--
-- Fed reactively by the dispatch `errorClass:"auth"` classifier (a single failure
-- can be a concurrent-refresh race, so we flip to needs_reauth only at the
-- 2-failure threshold; a successful call resets the counter). Idempotent guards
-- so re-runs are safe. Only meaningful on rows with a non-null `capability_id`.
--
-- Values (plain text — matches the table's encryption_mode/permission precedent):
--   connection_state  NULL | 'connected' (healthy) | 'needs_reauth' | 'disconnected'
--
-- No backfill: existing connection rows stay NULL, which the catalog treats as
-- healthy (no auth failure has ever been observed for them).

ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "connection_state" text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "auth_fail_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "last_auth_error_at" timestamp with time zone;
