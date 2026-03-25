-- Skill Triggers
-- When/how a skill auto-activates (entity event, cron, manual)

CREATE TABLE IF NOT EXISTS "skill_triggers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_id" uuid NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "type" text NOT NULL,
  "event_pattern" text,
  "filters" jsonb,
  "cron_expression" text,
  "channel_type" text NOT NULL DEFAULT 'personal',
  "is_active" boolean NOT NULL DEFAULT true,
  "automation_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "skill_triggers_skill_id_idx" ON "skill_triggers" ("skill_id");
CREATE INDEX IF NOT EXISTS "skill_triggers_workspace_id_idx" ON "skill_triggers" ("workspace_id");
CREATE INDEX IF NOT EXISTS "skill_triggers_type_idx" ON "skill_triggers" ("type");
