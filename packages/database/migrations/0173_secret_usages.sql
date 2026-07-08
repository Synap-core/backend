-- 0173_secret_usages.sql
--
-- Vault Next-Grade WP-B1: `secret_usages` many-to-many join.
--
-- Answers the "Connections" face of a secret — WHERE is this secret used? A
-- single secret can be consumed by many things (a capability connection, a
-- bound tool credential, a channel connection, an entity binding, an
-- automation, or a raw url match). The connection-registry columns already on
-- `secrets` (`capability_id`, `context_type`/`context_id`) only cover the 1:1
-- capability-connection case; this table generalizes it to N consumers.
--
-- `consumer_id` is polymorphic TEXT (no FK — it can point at a capability,
-- tool, channel, entity, automation, or a url string); the display label is
-- denormalized into `consumer_label` so the "Used by" list renders cheaply.
--
-- STRICT migration rules: IF NOT EXISTS everywhere; also mirrored into
-- 0000_baseline_schema.sql and asserted in schema-coherence.ts.

CREATE TABLE IF NOT EXISTS "secret_usages" (
  "id"             uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  "secret_id"      uuid  NOT NULL REFERENCES "secrets"("id") ON DELETE CASCADE,
  "consumer_type"  text  NOT NULL,  -- capability | tool | connection | entity | automation | url
  "consumer_id"    text  NOT NULL,
  "consumer_label" text,
  "workspace_id"   uuid,
  "context_type"   text,
  "context_id"     text,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "secret_usages_unique"
    UNIQUE ("secret_id", "consumer_type", "consumer_id", "context_id")
);

-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "secret_usages" ADD COLUMN IF NOT EXISTS "secret_id" uuid REFERENCES "secrets"("id") ON DELETE CASCADE;
ALTER TABLE "secret_usages" ADD COLUMN IF NOT EXISTS "consumer_type" text;
ALTER TABLE "secret_usages" ADD COLUMN IF NOT EXISTS "consumer_id" text;
ALTER TABLE "secret_usages" ADD COLUMN IF NOT EXISTS "consumer_label" text;
ALTER TABLE "secret_usages" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "secret_usages" ADD COLUMN IF NOT EXISTS "context_type" text;
ALTER TABLE "secret_usages" ADD COLUMN IF NOT EXISTS "context_id" text;
ALTER TABLE "secret_usages" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS "idx_secret_usages_secret_id"
  ON "secret_usages" ("secret_id");
CREATE INDEX IF NOT EXISTS "idx_secret_usages_consumer"
  ON "secret_usages" ("consumer_type", "consumer_id");

-- ── One-time backfill ────────────────────────────────────────────────────────
-- Seed a 'capability' usage row for every secret that is already a capability
-- connection (`capability_id` non-null).
--
-- context_id uses the '' sentinel (NOT raw NULL) to match the write path
-- (capability-connections.ts upserts `context_id ?? ''`). This matters because
-- Postgres treats NULLs as DISTINCT in a UNIQUE constraint — a NULL context_id
-- here would never collide with the '' the app writes, so a re-run would
-- duplicate context-less rows. COALESCE to '' makes ON CONFLICT actually dedupe,
-- so re-running the migration is genuinely safe.
INSERT INTO "secret_usages" (
  "secret_id", "consumer_type", "consumer_id", "consumer_label",
  "workspace_id", "context_type", "context_id"
)
SELECT
  "id", 'capability', "capability_id"::text, "name",
  "workspace_id", "context_type", COALESCE("context_id", '')
FROM "secrets"
WHERE "capability_id" IS NOT NULL
ON CONFLICT DO NOTHING;
