-- Separate issuer authentication from membership mutation and add exact
-- project-scoped activation receipts. Project-only grants deliberately keep
-- workspace_id NULL so they cannot be mistaken for workspace membership.

ALTER TABLE "control_plane_member_activations"
  ADD COLUMN IF NOT EXISTS "scope_kind" text NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS "project_id" uuid;

ALTER TABLE "control_plane_member_activations"
  ALTER COLUMN "workspace_id" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'control_plane_member_activations_project_id_projects_id_fk'
  ) THEN
    ALTER TABLE "control_plane_member_activations"
      ADD CONSTRAINT "control_plane_member_activations_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id")
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'control_plane_member_activations_exact_scope_check'
  ) THEN
    ALTER TABLE "control_plane_member_activations"
      ADD CONSTRAINT "control_plane_member_activations_exact_scope_check"
      CHECK (
        ("scope_kind" = 'workspace' AND "workspace_id" IS NOT NULL AND "project_id" IS NULL)
        OR
        ("scope_kind" = 'project' AND "workspace_id" IS NULL AND "project_id" IS NOT NULL)
      );
  END IF;
END $$;

UPDATE "trusted_issuers"
SET
  "allowed_scopes" = array_append("allowed_scopes", 'membership:activate'),
  "updated_at" = NOW()
WHERE
  "is_built_in" = true
  AND "status" = 'approved'
  AND NOT ('membership:activate' = ANY("allowed_scopes"));
