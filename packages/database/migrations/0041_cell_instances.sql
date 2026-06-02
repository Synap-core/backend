-- Migration 0041: cell instances + polymorphic relations endpoints
--
-- Backend keystone for the cell-instance system. Two parts, both additive and
-- fully idempotent (ADD COLUMN/TABLE/INDEX IF NOT EXISTS), so a fresh pod and a
-- mid-version pod converge to the same shape:
--
--   1. cell_instances — concrete, addressable instances of the universal cell
--      rendering unit. config (JSONB) for declarative cells; source_document_id
--      references a versioned MinIO-backed `documents` row for content cells.
--
--   2. relations polymorphic endpoints — make source/target entity columns
--      NULLABLE and add {source,target}_kind ('entity' default) +
--      {source,target}_cell_id. Every EXISTING relation defaults to kind='entity'
--      with both entity columns populated, so entity↔entity relations are
--      UNCHANGED. A new cell endpoint sets kind='cell' and the *_cell_id column.
--
-- The runner wraps this file in a single transaction — no explicit BEGIN/COMMIT.

-- ── 1. cell_instances ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "cell_instances" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"       uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id"            text NOT NULL,
  "cell_type"          text NOT NULL,
  "config"             jsonb NOT NULL DEFAULT '{}'::jsonb,
  "name"               text,
  "is_template"        boolean NOT NULL DEFAULT false,
  "source_document_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL,
  "created_by_kind"    text NOT NULL DEFAULT 'user',
  "trust_level"        text NOT NULL DEFAULT 'trusted',
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now()
);

-- Idempotent column guards (for any pre-existing table shape)
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "workspace_id"       uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "user_id"            text;
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "cell_type"          text;
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "config"             jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "name"               text;
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "is_template"        boolean NOT NULL DEFAULT false;
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "source_document_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL;
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "created_by_kind"    text NOT NULL DEFAULT 'user';
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "trust_level"        text NOT NULL DEFAULT 'trusted';
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "created_at"         timestamp with time zone NOT NULL DEFAULT now();
ALTER TABLE "cell_instances" ADD COLUMN IF NOT EXISTS "updated_at"         timestamp with time zone NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS "cell_instances_workspace_id_idx"
  ON "cell_instances" ("workspace_id");

CREATE INDEX IF NOT EXISTS "cell_instances_workspace_template_idx"
  ON "cell_instances" ("workspace_id", "is_template");

CREATE INDEX IF NOT EXISTS "cell_instances_cell_type_idx"
  ON "cell_instances" ("cell_type");

-- ── 2. relations polymorphic endpoints (ADDITIVE) ───────────────────────────

-- 2a. Make the entity endpoint columns nullable. A cell endpoint leaves the
--     corresponding entity column NULL. Existing rows are untouched (they keep
--     their entity ids). DROP NOT NULL is idempotent (no-op if already null).
ALTER TABLE "relations" ALTER COLUMN "source_entity_id" DROP NOT NULL;
ALTER TABLE "relations" ALTER COLUMN "target_entity_id" DROP NOT NULL;

-- 2b. Endpoint-kind discriminators. Default 'entity' so every existing row is
--     an entity↔entity edge with no data change.
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "source_kind" text NOT NULL DEFAULT 'entity';
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "target_kind" text NOT NULL DEFAULT 'entity';

-- 2c. Cell-instance endpoints (NULL unless the matching kind is 'cell').
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "source_cell_id" uuid REFERENCES "cell_instances"("id") ON DELETE CASCADE;
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "target_cell_id" uuid REFERENCES "cell_instances"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "relations_source_cell_id_idx"
  ON "relations" ("source_cell_id")
  WHERE "source_cell_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "relations_target_cell_id_idx"
  ON "relations" ("target_cell_id")
  WHERE "target_cell_id" IS NOT NULL;
