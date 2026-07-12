-- 0183_ai_teaching_substrate_columns.sql
-- AI Teaching Substrate (Wave 1a): links instruction skills to the tools/verbs
-- they teach, adds progressive-disclosure grouping + core-DNA flag to skills,
-- and adds a per-kind AI posture base layer to profiles. See
-- AI-TEACHING-SUBSTRATE-PLAN.md decisions D1/D4 (amended: final production
-- columns, no jsonb-deferral). Idempotent per repo migration rules.

ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "teaches_tools" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "skill_group" text;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "always_on" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_skills_teaches_tools" ON "skills" USING GIN ("teaches_tools");

ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "ai_posture" jsonb;
