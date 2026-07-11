-- 0179_playbook_automations.sql
-- Playbook → automations composition, first-class & editable.
--
-- Today a playbook composes N automations ONLY as read-only `links` edges
-- (`automation --member_of--> playbook`). This promotes that composition to a
-- first-class, editable join table so a playbook can own an ordered, role-tagged
-- set of automations that a later wave can add/remove/reorder.
--
-- Soft-link convention (matches focus_sessions.playbook_id / subject_entity_id):
-- no FK to playbooks or automations — both ids are enforced at the application
-- layer to avoid migration ordering issues. Strictly ADDITIVE.

CREATE TABLE IF NOT EXISTS "playbook_automations" (
  "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "playbook_id"   uuid        NOT NULL,
  "automation_id" uuid        NOT NULL,
  "role"          text,
  "sort_order"    integer,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_playbook_automations_unique"
  ON "playbook_automations" ("playbook_id", "automation_id");
CREATE INDEX IF NOT EXISTS "idx_playbook_automations_playbook_id"
  ON "playbook_automations" ("playbook_id");

-- Backfill from the existing read-only link edges. The `links` table stores the
-- edge as `automation --member_of--> playbook`, i.e. from_type='automation',
-- from_id=automationId, to_type='playbook', to_id=playbookId, link_type='member_of'.
-- (Column names confirmed in packages/database/src/schema/links.ts.)
INSERT INTO "playbook_automations" ("playbook_id", "automation_id")
SELECT "to_id"::uuid, "from_id"::uuid
  FROM "links"
 WHERE "from_type" = 'automation'
   AND "link_type" = 'member_of'
   AND "to_type"   = 'playbook'
ON CONFLICT DO NOTHING;
