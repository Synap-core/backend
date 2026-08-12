-- 0235_config_settings.sql
--
-- config_settings — a general, layered per-granularity config store that MIRRORS
-- governance_rules (0215). A specificity-ranking resolver (`resolveGuidelines`)
-- reads the rows. Used first for GUIDELINES: natural-language intent (key =
-- 'guideline') injected into `message.interpret`'s prompt. Additive; interpret
-- with no guidelines behaves exactly as before.
--
-- scope_kind (general → specific): default | channelType | bridge | channel |
-- shape. scope_ref = toolId | channelType | channelId | NULL. A shape row carries
-- its predicate in `shape` (MessageShapePredicate), not `scope_ref`.
-- workspace_id NULL = pod-wide (owner-floored by created_by on read).

DO $$ BEGIN
  CREATE TYPE config_scope_kind AS ENUM ('default', 'bridge', 'channelType', 'channel', 'shape');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "config_settings" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "capability_id"  uuid,
  "scope_kind"     config_scope_kind NOT NULL,
  "scope_ref"      text,
  "key"            text NOT NULL,
  "value"          jsonb NOT NULL,
  "shape"          jsonb,
  "workspace_id"   uuid,
  "source"         text NOT NULL DEFAULT 'user',
  "created_by"     text NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "revoked_at"     timestamptz
);

-- Idempotent guard for pre-existing tables (mirrors repo convention).
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "capability_id" uuid;
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "scope_kind" config_scope_kind;
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "scope_ref" text;
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "key" text;
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "value" jsonb;
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "shape" jsonb;
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'user';
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;

-- Resolver's primary lookup: active rows for a (key, workspace, scope) tuple;
-- the resolver ranks matches by specificity in application code.
CREATE INDEX IF NOT EXISTS "config_settings_key_scope_idx"
  ON "config_settings" ("key", "workspace_id", "scope_kind", "scope_ref")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "config_settings_capability_idx"
  ON "config_settings" ("capability_id")
  WHERE "revoked_at" IS NULL;
