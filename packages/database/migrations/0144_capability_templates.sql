-- 0144 — Templates-as-data: the `capability_templates` table.
--
-- The capability-template applier previously loaded a `templateKey` ONLY from
-- files on disk (synap-backend/templates/capabilities/*.capability.json), which
-- are not bundled into the deployed @synap/api image → a `templateKey` apply
-- 404'd on a deployed pod. This table makes the seed CapabilityDefinitions
-- DB-resident; the loader resolves a key DB-first (workspace row → pod-wide row)
-- and only then falls back to the file scan (dev ergonomics).
--
-- Scoping mirrors tools.workspace_id: NULL = pod-wide (the eve-seed case), SET =
-- workspace overlay. Defensive/idempotent per backend-rules.

CREATE TABLE IF NOT EXISTS "capability_templates" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key"          text        NOT NULL,
  "workspace_id" uuid        REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name"         text        NOT NULL,
  "description"  text,
  "definition"   jsonb       NOT NULL,
  "version"      integer     NOT NULL DEFAULT 1,
  "source"       text,
  "created_by"   text,
  "deleted_at"   timestamptz,
  "deleted_by"   text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

-- One LIVE pod-wide template per key (workspace overlays + soft-deleted rows excluded).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_capability_templates_key_pod_wide"
  ON "capability_templates" ("key")
  WHERE "workspace_id" IS NULL AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_capability_templates_key"
  ON "capability_templates" ("key");
CREATE INDEX IF NOT EXISTS "idx_capability_templates_workspace_id"
  ON "capability_templates" ("workspace_id");
