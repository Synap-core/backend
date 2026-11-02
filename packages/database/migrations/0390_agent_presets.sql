-- 0390 — presets per agent (B6, wave 53e873ed, plan v2 §4): a STORED, named way
-- an agent runs for a purpose (a role: reviewer, video editor). Prior art: Raycast
-- presets, Zed ACP agent servers. Roles start as presets (decision 5e7c77dc); a
-- role that needs its own grants is its own agent, not a preset.
--
-- A preset is a row of `agent_configs`, the one store for per-agent
-- configuration, which already holds the instructions (`prompt_append`) and the
-- default model (`model_override`). It adds:
--
--   preset_key         the preset's slug, unique per agent; NULL = the row is
--                      not a preset (the IS's per-workspace override, unchanged)
--   preset_label       how a person calls it
--   provider_override  its default provider, a MODEL_PROVIDERS slug
--   skill_slugs        the skills it loads
--
-- A preset is pod-wide for its agent (`user_id`): `workspace_id` stays NULL
-- (CHECK below), so no workspace-keyed reader of the IS override ever sees one.
-- Its harness and computer are the agent's own (`users.agent_type`,
-- `users.host_user_id`), never stored a second time. Model and provider are
-- defaults; what a run used stays a per-run fact (0389).
--
-- Fresh installs get all of this from 0000_baseline_schema.sql.

ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "preset_key" text;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "preset_label" text;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "provider_override" text;
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "skill_slugs" jsonb NOT NULL DEFAULT '[]';

CREATE UNIQUE INDEX IF NOT EXISTS "agent_configs_user_preset_unique"
  ON "agent_configs" ("user_id", "preset_key")
  WHERE "preset_key" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_configs_preset_pod_wide'
  ) THEN
    ALTER TABLE "agent_configs"
      ADD CONSTRAINT "agent_configs_preset_pod_wide"
      CHECK ("preset_key" IS NULL OR "workspace_id" IS NULL);
  END IF;
END $$;
