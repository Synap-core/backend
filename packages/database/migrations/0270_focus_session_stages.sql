-- 0270_focus_session_stages.sql
--
-- Gives a SESSION its own phases.
--
-- WHY. `focus_sessions` already owns `expected_outputs` and `criteria` — both
-- seeded from the playbook at instantiate, both directly authorable afterwards.
-- `stages` was the missing third, and its absence had one visible consequence:
-- a session that runs NO playbook could not have phases at all, because the
-- only stage list in the system lived on the playbook. The UI then fell back to
-- a flat deliverable list, which is the "it still feels like just one big list"
-- report. Measured on the live pod when this was written: 10 of 14 open
-- sessions had no playbook, exactly 1 could have displayed a stage, and 0 were
-- in one.
--
-- WHAT THIS IS NOT. It is not a third source of truth for a RUN's gate. The
-- gate already resolves against `playbook_runs.definition_snapshot.stages`
-- first and falls back to the live playbook (`services/playbooks/stage-gate.ts`),
-- and that is unchanged. This column is what the SESSION is doing, which is
-- what a person reads; the snapshot remains what the run was STARTED with,
-- which is what the gate must judge against.
--
-- SAFETY. NOT NULL with a `'[]'` default, so every existing row is valid the
-- moment this runs and no backfill is needed. An empty array means "this
-- session declares no phases" — the same thing a stageless playbook means, and
-- the same draw.

ALTER TABLE "focus_sessions"
  ADD COLUMN IF NOT EXISTS "stages" jsonb NOT NULL DEFAULT '[]'::jsonb;
