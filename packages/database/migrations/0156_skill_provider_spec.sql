-- 0156_skill_provider_spec.sql
-- Two-tier capability execution: add the declarative provider-verb spec column.
--
-- A `kind:'provider'` skill is a DECLARATIVE spec the pod executes in-process
-- via `triggerProviderAction` (no Intelligence Service isolate). This is purely
-- additive — existing `kind:'code'`/`'instruction'` skills are untouched.
--
-- `skills.kind` is a plain text column (text CHECK is enforced at the Drizzle
-- layer, not the DB), so adding the "provider" kind needs NO enum migration.

ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "provider_spec" jsonb;
