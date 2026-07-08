-- 0174_entity_facets.sql
-- Kind + Facets Wave 1A — entities gain additive ROLES ("facets"). A profile
-- can now be a base 'kind' (the entity's primary type, e.g. person, company)
-- or a 'role' (an attachable facet, e.g. investor, speaker) that layers onto
-- an entity without changing its kind. `entity_facets` attaches role-profiles
-- to entities; `profiles.profile_kind` + `applicable_kinds` gate which
-- profiles can be used as facets and on which entity kinds.
--
-- Strictly additive: profile_kind defaults to 'kind' so every existing
-- profile keeps behaving exactly as today. Nothing reads entity_facets yet.

-- ── profiles: kind vs role ────────────────────────────────────────────────
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "profile_kind" text NOT NULL DEFAULT 'kind';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "applicable_kinds" text[];

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_profile_kind_check'
  ) THEN
    ALTER TABLE "profiles"
      ADD CONSTRAINT "profiles_profile_kind_check"
      CHECK ("profile_kind" IN ('kind', 'role'));
  END IF;
END $$;

-- ── entity_facets: role-profiles attached to entities ──────────────────────
CREATE TABLE IF NOT EXISTS "entity_facets" (
  "id"                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id"           uuid    NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "profile_id"          uuid    NOT NULL REFERENCES "profiles"("id") ON DELETE RESTRICT,
  "user_id"             text    NOT NULL,
  "workspace_id"        uuid,
  "context_entity_id"   uuid    REFERENCES "entities"("id") ON DELETE SET NULL,
  "status"              text,
  "properties"          jsonb   NOT NULL DEFAULT '{}',
  "metadata"            jsonb   NOT NULL DEFAULT '{}',
  -- Provenance (mirrors entities/documents/relations — Wave B3, 0107)
  "created_by_kind"     text,
  "created_by_user_id"  text REFERENCES "users"("id") ON DELETE SET NULL,
  "agent_user_id"       text REFERENCES "users"("id") ON DELETE SET NULL,
  "source_proposal_id"  uuid REFERENCES "proposals"("id") ON DELETE SET NULL,
  "correlation_id"      uuid,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at"          timestamp with time zone
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "profile_id" uuid REFERENCES "profiles"("id") ON DELETE RESTRICT;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "context_entity_id" uuid REFERENCES "entities"("id") ON DELETE SET NULL;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "properties" jsonb DEFAULT '{}';
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}';
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "created_by_kind" text;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "agent_user_id" text REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "source_proposal_id" uuid REFERENCES "proposals"("id") ON DELETE SET NULL;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "correlation_id" uuid;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

-- Re-attach after soft-detach must succeed, so the uniqueness floor is partial
-- (only live rows collide) and treats NULL context/workspace as a fixed
-- sentinel so COALESCE-equal NULLs are still caught by the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "entity_facets_entity_profile_ctx_ws_uniq"
  ON "entity_facets" (
    "entity_id",
    "profile_id",
    COALESCE("context_entity_id", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "entity_facets_entity_id_idx"
  ON "entity_facets" ("entity_id")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "entity_facets_profile_workspace_idx"
  ON "entity_facets" ("profile_id", "workspace_id")
  WHERE "deleted_at" IS NULL;
