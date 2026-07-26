-- 0212_contextual_onboarding_journeys.sql
--
-- Durable, per-user contextual onboarding progress. The denormalized lens_key
-- makes pod/workspace/project/intersection identity unique despite nullable
-- foreign keys. All UI/AI behavior remains application-layer and proposal
-- governed; this table only records journey state and evidence.

CREATE TABLE IF NOT EXISTS "onboarding_journeys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "lens_kind" text NOT NULL,
  "lens_key" text NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "template_version" text NOT NULL DEFAULT '1',
  "status" text NOT NULL DEFAULT 'offered',
  "progress" jsonb NOT NULL DEFAULT '{"completedActionIds":[],"values":{}}'::jsonb,
  "evidence" jsonb NOT NULL DEFAULT '{"meaningfulEntityIds":[],"completedCriteria":[]}'::jsonb,
  "offered_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "paused_at" timestamptz,
  "completed_at" timestamptz,
  "dismissed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "onboarding_journeys_lens_kind_check"
    CHECK ("lens_kind" IN ('pod', 'workspace', 'project', 'project_workspace')),
  CONSTRAINT "onboarding_journeys_status_check"
    CHECK ("status" IN ('offered', 'active', 'paused', 'completed', 'dismissed')),
  CONSTRAINT "onboarding_journeys_lens_ids_check"
    CHECK (
      ("lens_kind" = 'pod' AND "workspace_id" IS NULL AND "project_id" IS NULL)
      OR ("lens_kind" = 'workspace' AND "workspace_id" IS NOT NULL AND "project_id" IS NULL)
      OR ("lens_kind" = 'project' AND "workspace_id" IS NULL AND "project_id" IS NOT NULL)
      OR ("lens_kind" = 'project_workspace' AND "workspace_id" IS NOT NULL AND "project_id" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_journeys_user_lens_version_unique"
  ON "onboarding_journeys" ("user_id", "lens_key", "template_version");
CREATE INDEX IF NOT EXISTS "onboarding_journeys_user_status_idx"
  ON "onboarding_journeys" ("user_id", "status");
CREATE INDEX IF NOT EXISTS "onboarding_journeys_workspace_id_idx"
  ON "onboarding_journeys" ("workspace_id");
CREATE INDEX IF NOT EXISTS "onboarding_journeys_project_id_idx"
  ON "onboarding_journeys" ("project_id");
