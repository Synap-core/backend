-- 0361 — playbook_runs.stop_reason + automation_runs.stop_reason (founder F3
-- default, 2026-10-27).
--
-- An unattended run (an automation started it) that spends its continuations
-- at its token budget or step limit ENDS `failed`: nobody can be asked to keep
-- it going. A failed child re-settles its parent automation run `failed`, and
-- ten of those in a row turned the rule off with an `automation.broken`
-- notice, though nothing broke. `stop_reason = 'budget'` says why the run
-- stopped; the breakers skip a parent run that carries it.
--
-- Additive and nullable (NULL = an ordinary verdict): the previous release
-- neither reads nor writes it, so a rollback onto this schema is safe.

ALTER TABLE "playbook_runs" ADD COLUMN IF NOT EXISTS "stop_reason" text;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "stop_reason" text;
