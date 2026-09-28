-- 0288 — indexes for the activity ledger's per-source order (`activity.list`).
--
-- Each source reads `ORDER BY at DESC, id DESC LIMIT n` past a row-value cursor
-- `(at, id) < ($1, $2)` (services/activity/list-activity.ts). With an index on
-- exactly `(at DESC, id DESC)` Postgres walks the index and stops after n rows
-- instead of sorting every visible row on every page.
--
-- Additive + idempotent (IF NOT EXISTS). Not declared in the drizzle schema, so
-- schema coherence neither requires nor rejects them.

-- proposal source: at = created_at.
CREATE INDEX IF NOT EXISTS "idx_proposals_created_at_id"
  ON "proposals" ("created_at" DESC, "id" DESC);

-- decision source: at = reviewed_at, only rows a person reviewed.
CREATE INDEX IF NOT EXISTS "idx_proposals_reviewed_at_id"
  ON "proposals" ("reviewed_at" DESC, "id" DESC)
  WHERE "reviewed_by" IS NOT NULL;

-- run source (playbooks): at = coalesce(completed_at, started_at).
CREATE INDEX IF NOT EXISTS "idx_playbook_runs_activity_at_id"
  ON "playbook_runs" ((coalesce("completed_at", "started_at")) DESC, "id" DESC);
