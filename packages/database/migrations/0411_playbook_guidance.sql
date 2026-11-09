-- 0411_playbook_guidance
--
-- A PLAYBOOK declares the rules it follows (design b199a3a4, slice 1a):
-- `guidance`, an ordered list of REFERENCES by kind or skill slug, never ids:
--   [{ "ref": "kind:brand-voice-guide", "where": { "voice-context": ["general"] } },
--    { "ref": "kind:outreach-angle" }, { "ref": "skill:creative-director" }]
-- The method renderer (`renderPlaybookMethod`) resolves each ref to its
-- CURRENT, person-approved version at run time and renders it under "Rules
-- this playbook follows"; the run records what it used in
-- `playbook_runs.definition_snapshot.guidance`.
--
-- NO backfill and NO constraint on the contents: `[]` (the default) is the
-- honest reading for every playbook that declares nothing. The grammar of a ref
-- is enforced at the write door (`@synap-core/types/guidance`
-- `validateGuidanceList`), the one place that can name the offending item.
--
-- Fresh installs also get the column from 0000_baseline_schema.sql. This file
-- is for pods that already booted.

ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "guidance" jsonb NOT NULL DEFAULT '[]'::jsonb;
