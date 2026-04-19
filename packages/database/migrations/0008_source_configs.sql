-- Pluggable feed source system (Phase 1 + 2 of the Feeds feature).
--
-- Two tables:
--   source_configs       — Pod-side, admin-managed provider configurations.
--                           One row = one "registered source the Pod can talk
--                           to" (an RSSHub endpoint, a SerpAPI-via-CP-relay,
--                           a bespoke HTTP JSON API, …). Credential-shaped
--                           fields inside `config` are stored as
--                           `vault://<secret-uuid>/<field>` references;
--                           plaintext lives in `secrets` with
--                           encryption_mode='server'.
--
--   source_subscriptions — Binds a feed (feeds.id) to a source_config with
--                           per-feed params + cursor for incremental pulls.
--
-- Written defensively (IF NOT EXISTS) so this migration is re-runnable and
-- safe alongside 0099-style reconciliations.

-- ── source_configs ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "source_configs" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"           text NOT NULL,
  "workspace_id"      uuid,
  "provider_type"     text NOT NULL,
  "name"              text NOT NULL,
  "description"       text,
  "config"            jsonb NOT NULL,
  "enabled"           boolean NOT NULL DEFAULT true,
  "last_tested_at"    timestamp with time zone,
  "last_test_status"  text,
  "last_test_error"   text,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_source_configs_user_id"
  ON "source_configs" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_source_configs_provider_type"
  ON "source_configs" ("provider_type");
CREATE INDEX IF NOT EXISTS "idx_source_configs_enabled"
  ON "source_configs" ("enabled");

-- ── source_subscriptions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "source_subscriptions" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"           text NOT NULL,
  "workspace_id"      uuid,
  "feed_id"           uuid NOT NULL,
  "source_config_id"  uuid NOT NULL,
  "params"            jsonb NOT NULL DEFAULT '{}'::jsonb,
  "cursor"            text,
  "last_fetched_at"   timestamp with time zone,
  "last_item_at"      timestamp with time zone,
  "status"            text NOT NULL DEFAULT 'active',
  "error_message"     text,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "source_subscriptions_status_check" CHECK (
    status IN ('active', 'paused', 'error')
  )
);

-- FK → source_configs (CASCADE on delete). Added defensively so the migration
-- succeeds even if run against a DB where the constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'source_subscriptions_source_config_id_fkey'
  ) THEN
    ALTER TABLE "source_subscriptions"
      ADD CONSTRAINT "source_subscriptions_source_config_id_fkey"
      FOREIGN KEY ("source_config_id")
      REFERENCES "source_configs"("id")
      ON DELETE CASCADE;
  END IF;
END;
$$;

-- FK → feeds (CASCADE on delete). Only added if the `feeds` table already
-- exists — it is created by migration 0007 and the single-directory runner
-- applies files alphabetically, so under normal operation this will always
-- succeed. The table check keeps this migration robust if feeds ever moves.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'feeds'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'source_subscriptions_feed_id_fkey'
  ) THEN
    ALTER TABLE "source_subscriptions"
      ADD CONSTRAINT "source_subscriptions_feed_id_fkey"
      FOREIGN KEY ("feed_id")
      REFERENCES "feeds"("id")
      ON DELETE CASCADE;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "idx_source_subscriptions_feed_id"
  ON "source_subscriptions" ("feed_id");
CREATE INDEX IF NOT EXISTS "idx_source_subscriptions_source_config_id"
  ON "source_subscriptions" ("source_config_id");
CREATE INDEX IF NOT EXISTS "idx_source_subscriptions_status_last_fetched"
  ON "source_subscriptions" ("status", "last_fetched_at");
