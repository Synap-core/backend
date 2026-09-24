-- 0272 — project_tracks + focus_sessions.track_id
--
-- A PROJECT is long-lived intent. A TRACK is a METHOD running inside ONE
-- project ("Business model", "Content", "Build" inside "Launch The Architech").
-- A project has N tracks; a method (a playbook with scope = 'project') is
-- reusable by any number of projects.
--
-- WHY ITS OWN TABLE. A track is neither a playbook run (runs are single
-- executions the reaper retires after 24h quiet) nor a long-lived focus
-- session (reapers, ambient write attribution, twin dedup, orient counts and
-- owed slots all assume a session ENDS). It is the thing sessions are born
-- INSIDE of.
--
-- WHY A SNAPSHOT. Each track PINS the method definition it was started from
-- (`definition_snapshot` + `method_version`), exactly like
-- `playbook_runs.definition_snapshot`: an edit to the method must not silently
-- rewrite the vocabulary a live track is already sitting in. Applying a newer
-- method version is an explicit, later act.
--
-- `playbook_id` is NULLABLE + ON DELETE SET NULL: deleting a method must not
-- delete the history of the projects that ran it.
--
-- NOTE: `projects` is created by 0151_consolidate_projects_table.sql, NOT by
-- 0000_baseline_schema.sql, so `project_tracks` (FK → projects) is deliberately
-- NOT in the baseline — the same exemption as `projects.color_slot` (0271).
-- schema-coherence.ts carries its startup guard. `focus_sessions.track_id` IS
-- mirrored in the baseline, as a plain nullable column; the FK below is added
-- here only, once `project_tracks` exists.

CREATE TABLE IF NOT EXISTS "project_tracks" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id"          uuid        NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id"             text        NOT NULL,
  "playbook_id"         uuid        REFERENCES "playbooks"("id") ON DELETE SET NULL,
  "name"                text        NOT NULL,
  "definition_snapshot" jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "method_version"      text        NOT NULL DEFAULT '1',
  "current_stage"       text,
  "status"              text        NOT NULL DEFAULT 'active',
  "metadata"            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_tracks_status_check'
  ) THEN
    ALTER TABLE "project_tracks"
      ADD CONSTRAINT "project_tracks_status_check"
      CHECK ("status" IN ('active', 'paused', 'completed', 'archived'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_project_tracks_project_id"
  ON "project_tracks" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_tracks_playbook_id"
  ON "project_tracks" ("playbook_id");
-- Starting the same method twice on one project is IDEMPOTENT: the service
-- returns the existing live track. An archived track frees the slot, so a
-- method can be restarted from scratch after being archived.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_tracks_live_method"
  ON "project_tracks" ("project_id", "playbook_id")
  WHERE "status" <> 'archived' AND "playbook_id" IS NOT NULL;

-- Sessions are born INSIDE a track. Nullable: almost every session has none.
ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "track_id" uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'focus_sessions_track_id_fkey'
  ) THEN
    ALTER TABLE "focus_sessions"
      ADD CONSTRAINT "focus_sessions_track_id_fkey"
      FOREIGN KEY ("track_id") REFERENCES "project_tracks"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "idx_focus_sessions_track_id"
  ON "focus_sessions" ("track_id");

-- ── BACKFILL — the proto-track ─────────────────────────────────────────────
-- Until this migration a project could follow exactly ONE method:
-- `projects.instantiateFromPlaybook` deep-copied the playbook's stages into
-- `projects.settings.stages` and seeded `projects.phase`. Every such project
-- becomes exactly ONE track here.
--
--   playbook_id    settings.sourcePlaybookId, only when it is a well-formed
--                  uuid naming a playbook that still exists (else NULL).
--   name           that playbook's name, else 'Method'.
--   snapshot       { stages: settings.stages } — the copy the project holds,
--                  NOT the live playbook (which may have changed since).
--   current_stage  projects.phase, only when it names one of those stages.
--
-- IDEMPOTENT: a project that already carries a track stamped
-- `metadata.backfill = '0272'` is skipped, whatever that track's status — so a
-- re-run never duplicates, and never resurrects a track someone archived.
--
-- NOT DROPPED HERE: `projects.phase` and `projects.settings.stages` still have
-- readers (projects.list/get `phaseCategory`, the browser board/lanes, the MCP
-- project tools). They are migrated to read tracks in a later wave; only then
-- can the columns/keys go.
INSERT INTO "project_tracks"
  ("project_id", "user_id", "playbook_id", "name", "definition_snapshot",
   "method_version", "current_stage", "status", "metadata")
SELECT
  p."id",
  p."user_id",
  pb."id",
  COALESCE(pb."name", 'Method'),
  jsonb_build_object('stages', p."settings" -> 'stages'),
  COALESCE(
    NULLIF(p."settings" ->> 'sourcePlaybookVersion', ''),
    pb."version"::text,
    '1'
  ),
  CASE
    WHEN p."phase" IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p."settings" -> 'stages') AS s(stage)
      WHERE jsonb_typeof(s.stage) = 'object' AND s.stage ->> 'key' = p."phase"
    ) THEN p."phase"
    ELSE NULL
  END,
  'active',
  jsonb_build_object('backfill', '0272')
FROM "projects" p
-- CASE, not `regex AND ::uuid`: SQL does not promise short-circuit order, so a
-- malformed id must never reach the cast.
LEFT JOIN "playbooks" pb
  ON pb."id" = CASE
    WHEN (p."settings" ->> 'sourcePlaybookId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (p."settings" ->> 'sourcePlaybookId')::uuid
  END
WHERE jsonb_typeof(p."settings" -> 'stages') = 'array'
  AND jsonb_array_length(p."settings" -> 'stages') > 0
  AND NOT EXISTS (
    SELECT 1 FROM "project_tracks" t
    WHERE t."project_id" = p."id"
      AND t."metadata" ->> 'backfill' = '0272'
  );
