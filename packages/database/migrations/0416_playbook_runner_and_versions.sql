-- 0416_playbook_runner_and_versions
--
-- Who runs a playbook, the tools it needs, and every kept version of its
-- definition (founder decision, proposal 72fdca0b; spec document 7111934d,
-- slice 1). A STEP declares the same inside `playbooks.stages` (jsonb, no
-- migration): `runner`, `requires`, and `uses` (the step IS another playbook,
-- pinned at a version).
--
--  - `playbooks.runner`: a `PlaybookRunner` (`@synap/playbooks`), one choice or
--    an ordered list of fallbacks. NULL = nobody named, the reading of every
--    playbook before 0416.
--  - `playbooks.requires`: capability keys every step needs. `[]` = nothing.
--  - `playbook_versions`: one row per (playbook, version), written in the same
--    transaction as the write that sets `playbooks.version`. A step pinned at a
--    version that is no longer the live one runs THIS row. Append-only.
--
-- BACKFILL: each existing playbook's CURRENT version is kept, so a step can be
-- pinned to any playbook's version of today. Earlier versions were never kept;
-- a pin to one is refused at the write door ("pin version N or later").
-- `definition` keys are the camelCase field names of `PLAYBOOK_VERSION_FIELDS`
-- (@synap/api services/playbooks/playbook-versions.ts); keep the two in step.
--
-- No foreign key to playbooks: a playbook is archived, never deleted, and a
-- kept version must outlive any later cleanup of the live row.
--
-- Fresh installs also get all of this from 0000_baseline_schema.sql. This file
-- is for pods that already booted. Re-runnable: IF NOT EXISTS / ON CONFLICT.

ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "runner" jsonb;
ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "requires" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS "playbook_versions" (
  "playbook_id" uuid        NOT NULL,
  "version"     integer     NOT NULL,
  "definition"  jsonb       NOT NULL,
  "created_by"  text,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("playbook_id", "version")
);

INSERT INTO "playbook_versions" ("playbook_id", "version", "definition", "created_by", "created_at")
SELECT
  p."id",
  p."version",
  jsonb_build_object(
    'name', p."name",
    'description', p."description",
    'goalTemplate', p."goal_template",
    'params', p."params",
    'inputStrategy', p."input_strategy",
    'channelSpec', p."channel_spec",
    'expectedOutputs', p."expected_outputs",
    'stages', p."stages",
    'criteria', p."criteria",
    'requiredIntents', p."required_intents",
    'guidance', p."guidance",
    'subjectProfile', p."subject_profile",
    'executor', p."executor",
    'scope', p."scope",
    'runner', p."runner",
    'requires', p."requires"
  ),
  p."created_by",
  p."updated_at"
FROM "playbooks" p
ON CONFLICT ("playbook_id", "version") DO NOTHING;
