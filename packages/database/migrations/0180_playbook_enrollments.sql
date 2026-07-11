-- 0180_playbook_enrollments.sql
-- Entity ↔ playbook enrollment, many entities per playbook.
--
-- Today a playbook can only act on ONE entity, faked as
-- `focus_sessions.subject_entity_id`. This promotes enrollment to a first-class
-- join so many entities can be enrolled in a single playbook, each with its own
-- lifecycle status and per-entity step position.
--
-- Soft-link convention (matches focus_sessions.subject_entity_id): no FK on
-- `entity_id` (or `playbook_id`). `status` is plain text with no CHECK, matching
-- the focus_sessions.status convention (values: active/paused/completed/cancelled).
--
-- SECURITY (later wave): the enrollment WRITE path MUST enforce
-- workspace-visibility on `entity_id` in the application layer — there is no FK,
-- so a crafted `entity_id` could otherwise enroll (and act on) an entity in
-- another workspace (IDOR). Mirror the write-side guard at
-- packages/jobs/src/workers/automation-executor.ts:1632-1648 (bind the entity
-- ONLY if its workspaceId matches the caller's workspace OR is pod-wide NULL).
-- Strictly ADDITIVE.

CREATE TABLE IF NOT EXISTS "playbook_enrollments" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "playbook_id" uuid        NOT NULL,
  "entity_id"   uuid        NOT NULL,
  "status"      text        NOT NULL DEFAULT 'active',
  "step_state"  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "enrolled_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_playbook_enrollments_unique"
  ON "playbook_enrollments" ("playbook_id", "entity_id");
CREATE INDEX IF NOT EXISTS "idx_playbook_enrollments_playbook_id"
  ON "playbook_enrollments" ("playbook_id");
CREATE INDEX IF NOT EXISTS "idx_playbook_enrollments_entity_id"
  ON "playbook_enrollments" ("entity_id");
