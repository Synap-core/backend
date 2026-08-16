-- 0240_process_plane_tiers.sql
--
-- The Process Plane: three typed discriminators that let the work tiers stop
-- pretending to be each other. Additive and nullable throughout — every
-- existing row keeps working, and every reader falls back to today's behaviour
-- until it is migrated.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. focus_sessions.origin — THE DETANGLE
--
-- An automation run mints a `focus_sessions` row, and until now the ONLY way to
-- tell it from a human/AI work session was to sniff untyped JSONB:
--   metadata.automationId / metadata.automationRunId / metadata.source
-- (see resolveFocusSessionOrigin in @synap-core/focus-sessions). That means the
-- separation was RE-DERIVED in the UI on every render instead of living in the
-- data — which is precisely why no list, filter or grouping could cleanly split
-- automation runs from real sessions.
--
-- DELIBERATELY NOT a DB enum: the vocabulary is an app-level union
-- (`FocusSessionOrigin`), so it can extend without a migration — the same
-- reasoning as 0238's governance_reason.
--
-- BACKFILL below reproduces the existing sniff EXACTLY, in its existing
-- precedence order, so no row changes meaning. Rows that predate the metadata
-- convention resolve to 'agent', which is what the sniff already returned.
--
-- 2. playbooks.scope — SESSION TEMPLATE vs ENGAGEMENT BLUEPRINT
--
-- A playbook is documented as "a template of a Session". In practice some
-- playbooks coordinate rather than execute: they start sessions, attach
-- automations and trigger other flows (both such playbooks on the dogfood pod
-- stalled in `draft` — they did not fit the runtime). `scope` names that
-- difference so one object can serve both without a second template layer to
-- drift out of sync. Ordered phases already exist as `stages`.
--
-- NULL is read as 'session' — today's meaning — so nothing reclassifies itself.
--
-- 3. projects.phase — THE ENGAGEMENT LIFECYCLE
--
-- The long-running container's before/during/after state. Free text, not an
-- enum: a consulting engagement, a marketing campaign and a product each name
-- their phases differently, and the label is a config concern.
--
-- NOTE ON NAMING: `projects` stays the canonical table. The USER-FACING noun is
-- derived from what a project is linked to (an "engagement" when bound to a
-- client, a "product" when bound to a product entity, a plain project when
-- standalone) — the backend stays agnostic, config and UI decide the word.

-- ── 1. focus_sessions.origin ────────────────────────────────────────────────
ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "origin" text;

-- Backfill mirrors resolveFocusSessionOrigin's precedence exactly:
--   automation (source/automationId/automationRunId) > playbook (playbook_id) > agent
-- `jsonb_typeof(... -> key) = 'string'` and NOT `(... ->> key) IS NOT NULL`.
-- The sniff tests `typeof meta.automationId === "string"`, so a NON-string value
-- (a number, a boolean) is NOT an automation signal in JS. The `->>` operator
-- stringifies any scalar, so `IS NOT NULL` would classify `{"automationId": 123}`
-- as automation here while the code called it agent — the backfill would then
-- disagree with the very function it is meant to reproduce, on exactly the rows
-- nobody would think to check.
UPDATE "focus_sessions"
SET "origin" = CASE
  WHEN lower(coalesce("metadata" ->> 'source', '')) = 'automation'
    OR jsonb_typeof("metadata" -> 'automationId') = 'string'
    OR jsonb_typeof("metadata" -> 'automationRunId') = 'string'
    THEN 'automation'
  WHEN "playbook_id" IS NOT NULL THEN 'playbook'
  ELSE 'agent'
END
WHERE "origin" IS NULL;

-- Reads are "every session of kind X", so the index is on origin alone; the
-- user floor is applied by the access layer, not by this index.
CREATE INDEX IF NOT EXISTS "idx_focus_sessions_origin"
  ON "focus_sessions" ("origin");

-- ── 2. playbooks.scope ──────────────────────────────────────────────────────
ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "scope" text;

-- Every playbook that exists today is a session template by definition.
UPDATE "playbooks" SET "scope" = 'session' WHERE "scope" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_playbooks_scope" ON "playbooks" ("scope");

-- ── 3. projects.phase ───────────────────────────────────────────────────────
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "phase" text;
