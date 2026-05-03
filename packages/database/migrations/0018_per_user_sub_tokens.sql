-- ============================================================================
-- 0018_per_user_sub_tokens.sql — Per-external-user sub-token mappings
-- ============================================================================
--
-- Adds support for "shared OpenWebUI" / "family pod" deployments where one
-- external service (the OWUI install) holds a single Synap parent agent
-- key but serves multiple distinct humans. Without this, every OWUI user's
-- notes/threads/memory gets dumped under the same Synap user.
--
-- Two operating modes (the runtime picks one based on what the caller sends):
--
--   1. Header-based remapping (Mode 1)
--      The pipeline keeps using the parent agent key as the bearer and adds
--      `X-External-User-Id: <opaque>` per request. The auth middleware looks
--      up `(parent_api_key_id, external_user_id)` in `api_key_external_users`
--      and swaps the request's `userId` to the mapped Synap user. No mapping
--      yet → auto-create a Synap user + insert the mapping row in one
--      transaction. Cheap (no extra round-trip), good fit for OWUI pipelines.
--
--   2. Sub-token (Mode 2)
--      The caller mints a real child API key (`api_keys.parent_key_id` set)
--      and uses it as the bearer. Revoking the parent cascades to all
--      children via `ON DELETE CASCADE`. Heavier, but lets external code
--      hold "real" tokens it can rotate independently. Mode 2 endpoint is a
--      placeholder in this commit — schema is ready, route returns 501 for
--      `mintSubToken: true`.
--
-- All statements are idempotent — safe to re-apply.
-- ============================================================================

-- ─── 1. Add parent_key_id to api_keys (Mode 2 hook) ─────────────────────────
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "parent_key_id" uuid;

-- Add the FK as a separate idempotent step (CONSTRAINT IF NOT EXISTS isn't
-- universally supported; use a DO block to add it only when missing).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_keys_parent_key_id_fkey'
  ) THEN
    ALTER TABLE "api_keys"
      ADD CONSTRAINT "api_keys_parent_key_id_fkey"
      FOREIGN KEY ("parent_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "api_keys_parent_key_id_idx"
  ON "api_keys" ("parent_key_id")
  WHERE "parent_key_id" IS NOT NULL;

-- ─── 2. api_key_external_users — the mapping table ─────────────────────────
CREATE TABLE IF NOT EXISTS "api_key_external_users" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "parent_api_key_id"   uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "external_user_id"    text NOT NULL,
  "synap_user_id"       text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "child_api_key_id"    uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "metadata"            jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "last_used_at"        timestamp with time zone,
  CONSTRAINT "api_key_external_users_unique" UNIQUE ("parent_api_key_id", "external_user_id")
);

-- Defensive: ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "api_key_external_users" ADD COLUMN IF NOT EXISTS "parent_api_key_id" uuid;
ALTER TABLE "api_key_external_users" ADD COLUMN IF NOT EXISTS "external_user_id" text;
ALTER TABLE "api_key_external_users" ADD COLUMN IF NOT EXISTS "synap_user_id" text;
ALTER TABLE "api_key_external_users" ADD COLUMN IF NOT EXISTS "child_api_key_id" uuid;
ALTER TABLE "api_key_external_users" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb;
ALTER TABLE "api_key_external_users" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "api_key_external_users" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "api_key_external_users_parent_idx"
  ON "api_key_external_users" ("parent_api_key_id");

CREATE INDEX IF NOT EXISTS "api_key_external_users_synap_user_idx"
  ON "api_key_external_users" ("synap_user_id");
