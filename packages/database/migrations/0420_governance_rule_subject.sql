-- 0420 — governance_rules.target_subject_id / target_subject_version: a rule
-- that names ONE object, pinned to its version (founder decision, 10 Nov 2026,
-- proposal a01b9d46; plan fbfadf54 §6).
--
-- First use: a person pre-approves one playbook for agents. The rule is the
-- exact action `playbook.run` narrowed to that playbook (`target_subject_id`)
-- at the version they saw (`target_subject_version`, `playbooks.version`). A
-- subject only NARROWS which writes the rule matches, like `target_profile`
-- on an exact action; any edit that bumps the playbook's version leaves the
-- rule matching nothing, so the next agent launch asks again.
--
-- `principal_owner_id`: the person whose agents such a rule covers (the
-- person who made it). An `any` rule naming one object matches only an agent
-- acting for that person, so one member's approval never starts another
-- member's agent's run in a shared space.
--
-- All NULL = every rule before 0420, unchanged. No foreign key: a subject is
-- any governed object, not only a playbook.
--
-- Fresh installs also get these from 0000_baseline_schema.sql. Idempotent.

ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "target_subject_id" uuid;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "target_subject_version" integer;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "principal_owner_id" text;
