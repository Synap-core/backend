-- 0425_process_one_link
--
-- ONE LINK PER RELATION for a playbook's automations (Process wave plan
-- 0adf8352, founder-approved 16 Nov 2026, W2).
--
-- A playbook's automations were stored three ways: `playbooks.flow_automation_id`
-- (the cron schedule's backing automation, or the automation the canvas saved),
-- the `playbook_automations` join table (activators, composition, 0179), and the
-- legacy link `automation --member_of--> playbook` (dual-written into the join
-- table). From this release the join table is the ONE store every backend reader
-- reads (`services/playbooks/playbook-automation-links.ts`):
--   1. each `flow_automation_id` becomes its join row: role `schedule` when the
--      automation is a cron one (the schedule's backing row), else `flow` (the
--      canvas). A row that already composes the same automation takes it when
--      its role is NULL or not a canonical one (`schedule`, `flow`, `activator`,
--      `member`; e.g. a hand-tagged `driver`), so the canvas reads its flow; a
--      canonical role is kept. A dangling id (its automation is gone) is not
--      copied: every reader already ignored it.
--   2. every legacy `member_of` link not yet in the join table is copied (the
--      0179 backfill, again, for the links written since; role NULL, read as a
--      plain member).
--
-- KEPT ONE RELEASE (dropped in W5): `flow_automation_id` stays and is still
-- written beside the join row, because the browser before this release reads
-- it; the legacy `member_of` link rows stay too (no reader any more; a rollback
-- to the previous release's trigger matcher still reads them). Nothing writes a
-- new `member_of` link from this release on.
--
-- NOT DROPPED HERE: `playbooks.required_intents` (0291). 0419 stops reading it,
-- but 0419 has not shipped (newest tag v1.2.8 still reads it), and a failed
-- update rolls back to that release on this schema. The drop is a later
-- migration carrying `-- synap:contract-of 0419_playbook_tools.sql`, once 0419
-- is in a release tag (deploy/__tests__/migration-forward-only.test.sh).
--
-- Re-runnable: every insert is ON CONFLICT, and the role update takes over only
-- a NULL or non-canonical role, so a second run changes nothing.

INSERT INTO "playbook_automations" ("playbook_id", "automation_id", "role")
SELECT p."id",
       p."flow_automation_id",
       CASE WHEN a."trigger_type" = 'cron' THEN 'schedule' ELSE 'flow' END
  FROM "playbooks" p
  JOIN "automations" a ON a."id" = p."flow_automation_id"
 WHERE p."flow_automation_id" IS NOT NULL
ON CONFLICT ("playbook_id", "automation_id")
DO UPDATE SET "role" = EXCLUDED."role", "updated_at" = now()
 WHERE "playbook_automations"."role" IS NULL
    OR "playbook_automations"."role" NOT IN ('schedule', 'flow', 'activator', 'member');

INSERT INTO "playbook_automations" ("playbook_id", "automation_id")
SELECT l."to_id"::uuid, l."from_id"::uuid
  FROM "links" l
 WHERE l."from_type" = 'automation'
   AND l."link_type" = 'member_of'
   AND l."to_type"   = 'playbook'
   AND l."to_id"   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND l."from_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT ("playbook_id", "automation_id") DO NOTHING;
