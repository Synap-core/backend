-- 0268_playbook_kind_and_intake_style.sql
--
-- Two semantic discriminators on a playbook, both NULLABLE and both read
-- through ONE resolver so a legacy row never reclassifies itself. Same contract
-- as `playbooks.scope` (0240): NULL is not "unset pending a backfill", it is a
-- value with a documented reading.
--
-- `kind` — WHAT KIND of work this is: `interrogation` (it asks; the value is
--   the answers), `make` (it produces a deliverable), `review` (it judges
--   something that exists). NULL reads as `make` — every playbook written
--   before this column produced something, and calling them all
--   "interrogation" would be a claim the data does not support.
--   Read via `resolvePlaybookKind` (@synap/playbooks).
--
-- `intake_style` — HOW it collects its params: `form` (all up front),
--   `adaptive` (conversationally, as the run needs them), `auto` (the door
--   decides). NULL reads as `auto`, i.e. exactly today's behaviour — no door
--   has ever shown a form.
--   Read via `resolvePlaybookIntakeStyle` (@synap/playbooks).
--
-- Deliberately NOT pg enums: both vocabularies are young, and an enum here
-- would make a fourth value a migration rather than an edit to the closed TS
-- union that already has a build-stopping coverage floor.

ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "intake_style" text;
