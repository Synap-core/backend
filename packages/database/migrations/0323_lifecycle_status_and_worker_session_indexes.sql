-- 0323: read-cost indexes for the work model (review 2026-10-12, backend F3/F4/F13).
--
-- (1) `(profile_id, status)` on entities and entity_facets. The board and
-- `lifecycle.list` group one profile's live rows by status VALUE (a column
-- per option); 0319's `(profile_id, status_category)` serves the category
-- reads only. Partial on live rows, like 0319.
--
-- (2) An expression index on focus_sessions(metadata->>'automationId'). The
-- worker reads (`worker-enablement.ts`: "sessions this enablement opened",
-- in-flight count, listEnabledWorkers) match and group on it; without it each
-- one scans focus_sessions in full. PARTIAL on `IS NOT NULL` — only sessions
-- a rule opened carry the key, and `=` / `IN` imply the predicate (as 0303).
-- Idempotent.

CREATE INDEX IF NOT EXISTS "entities_profile_status_idx"
  ON "entities" ("profile_id", "status") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "entity_facets_profile_status_idx"
  ON "entity_facets" ("profile_id", "status") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS idx_focus_sessions_automation_id
  ON focus_sessions ((metadata->>'automationId'))
  WHERE (metadata->>'automationId') IS NOT NULL;
