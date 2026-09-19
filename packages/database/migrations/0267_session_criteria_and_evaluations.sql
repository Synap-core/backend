-- 0267_session_criteria_and_evaluations.sql
--
-- A session carries a CONTRACT (binary acceptance criteria) and a graded
-- EVALUATION of it.
--
-- `playbooks.criteria` / `focus_sessions.criteria` hold `SessionCriterion[]`
-- (@synap/playbooks). A playbook's criteria (plus every stage's, with `stageKey`
-- stamped) are copied onto the session at instantiate; an ad-hoc session may
-- declare its own through the start/update doors. Max 12, enforced at the doors.
--
-- `session_evaluations` is the grade — ONE ROW PER CRITERION PER ATTEMPT, never
-- baked into the session row (scores are a separate record attached to the
-- session). The current verdict per criterion is the latest row, except that a
-- `human` row wins over any non-human row regardless of time. Rows are
-- append-only: a re-evaluation is a new attempt, so the history of how a
-- criterion came to pass stays readable.

ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "criteria" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "criteria" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS "session_evaluations" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"     uuid NOT NULL REFERENCES "focus_sessions"("id") ON DELETE CASCADE,
  "user_id"        text NOT NULL,
  -- text, matching focus_sessions.workspace_id (a uuid/text mismatch 500s joins).
  "workspace_id"   text,
  "criterion_key"  text NOT NULL,
  "attempt"        integer NOT NULL DEFAULT 1,
  "verdict"        text NOT NULL CHECK ("verdict" IN ('pass', 'fail', 'unmeasured')),
  "evaluator_kind" text NOT NULL CHECK ("evaluator_kind" IN ('evidence', 'capability', 'judge', 'human')),
  -- agent id / capability verb / model id / user id
  "evaluator_id"   text,
  "evidence"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "rationale"      text,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_session_evaluations_session_id"
  ON "session_evaluations" ("session_id");
CREATE INDEX IF NOT EXISTS "idx_session_evaluations_session_criterion"
  ON "session_evaluations" ("session_id", "criterion_key", "created_at");
