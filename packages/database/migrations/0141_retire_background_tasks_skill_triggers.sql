-- 0141_retire_background_tasks_skill_triggers.sql
--
-- Final consolidation of the autonomous-behavior spine.
--
-- The unified spine now owns every autonomous-behavior concern:
--   * automations    = trigger SSoT (event + cron)
--   * playbooks      = work SSoT (session templates)
--   * delivery-router = delivery SSoT
--   * LoopDefinition = governed template
--
-- Two parallel mechanisms are retired here:
--   * skill_triggers  — skill activation is now plain `automations` rows.
--   * background_tasks — background scheduling is now playbooks + cron-automations.
--
-- The pod carries no data in these tables, so the drop is unconditional.
-- Defensive `IF EXISTS ... CASCADE` keeps the migration idempotent and safe on
-- a fresh pod (where the baseline no longer creates these tables).

DROP TABLE IF EXISTS "skill_triggers" CASCADE;
DROP TABLE IF EXISTS "background_tasks" CASCADE;
