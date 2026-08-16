-- ── Relations — entity↔entity edge idempotency (whiteboard canvas projection) ──
--
-- WHY NOW: the whiteboard projects graph relations onto the canvas as arrows and
-- lets the user draw an arrow to CREATE a relation. `relations.create`
-- (`packages/api/src/routers/relations.ts`) has a post-hoc 23505 catch that was
-- DEAD for generic types, because `relations` had no unique index on the edge
-- itself. A repeated create silently produced a duplicate row with a new id (and,
-- on the agent path, a duplicate proposal every time). Canvas projection
-- multiplies that: every re-draw is another edge.
--
-- ── TWO indexes, because relations have TWO visibility regimes ────────────────
--
-- `packages/api/src/access/registry.ts` (`nullWorkspaceMeans: "ownerPrivate"`):
--   · workspace_id IS NOT NULL → visible via the WORKSPACE lens. Two users in
--     the same workspace seeing the same edge are seeing ONE fact, so a repeat
--     is a genuine duplicate and must dedupe ACROSS owners.
--   · workspace_id IS NULL     → OWNER-PRIVATE (`relations.user_id = viewer`).
--     Two users may each hold their own pod-wide edge between the same two
--     entities; those are DIFFERENT rows belonging to different people.
--
-- A single index keyed on COALESCE(workspace_id, sentinel) and NOT on user_id
-- would therefore (a) DELETE one user's private edge to satisfy another's, and
-- (b) at runtime raise 23505 against a row the caller cannot even see — an
-- existence oracle. Hence the split below: owner is part of the key ONLY where
-- the row is owner-private.
--
-- ⚠️ THIS MIGRATION DELETES ROWS. Inspect the blast radius first, on a snapshot:
--
--   -- workspace-scoped duplicates
--   SELECT source_entity_id, target_entity_id, type, workspace_id, count(*)
--   FROM relations
--   WHERE source_kind='entity' AND target_kind='entity'
--     AND source_entity_id IS NOT NULL AND target_entity_id IS NOT NULL
--     AND workspace_id IS NOT NULL
--   GROUP BY 1,2,3,4 HAVING count(*) > 1;
--
--   -- pod-wide (owner-private) duplicates
--   SELECT source_entity_id, target_entity_id, type, user_id, count(*)
--   FROM relations
--   WHERE source_kind='entity' AND target_kind='entity'
--     AND source_entity_id IS NOT NULL AND target_entity_id IS NOT NULL
--     AND workspace_id IS NULL
--   GROUP BY 1,2,3,4 HAVING count(*) > 1;
--
-- Dedupe keeps the EARLIEST row (created_at, then id as a stable tie-break) so
-- the survivor retains its provenance columns (created_by_kind /
-- source_proposal_id / correlation_id). 0137 used ctid; this is strictly better.
--
-- Defensive / idempotent on re-run.

-- 1a. Dedupe WORKSPACE-scoped duplicates (across owners — one workspace fact).
DELETE FROM relations r
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY source_entity_id, target_entity_id, type, workspace_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM relations
  WHERE source_kind = 'entity'
    AND target_kind = 'entity'
    AND source_entity_id IS NOT NULL
    AND target_entity_id IS NOT NULL
    AND workspace_id IS NOT NULL
) dupes
WHERE r.id = dupes.id
  AND dupes.rn > 1;

-- 1b. Dedupe POD-WIDE duplicates PER OWNER (never across owners).
DELETE FROM relations r
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY source_entity_id, target_entity_id, type, user_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM relations
  WHERE source_kind = 'entity'
    AND target_kind = 'entity'
    AND source_entity_id IS NOT NULL
    AND target_entity_id IS NOT NULL
    AND workspace_id IS NULL
) dupes
WHERE r.id = dupes.id
  AND dupes.rn > 1;

-- 1c. Report what 1a/1b actually deleted. Migrations run UNATTENDED at pod
-- startup, so the "inspect the blast radius first" instruction above cannot be
-- followed in practice on a real deploy — without this, rows vanish with no
-- record. RAISE NOTICE lands in the migration log, which is the only place an
-- operator can later answer "how many relations did 0239 remove?".
DO $$
DECLARE
  remaining_ws  bigint;
  remaining_pod bigint;
BEGIN
  SELECT count(*) INTO remaining_ws  FROM relations WHERE workspace_id IS NOT NULL;
  SELECT count(*) INTO remaining_pod FROM relations WHERE workspace_id IS NULL;
  RAISE NOTICE '[0239] dedupe complete — relations remaining: % workspace-scoped, % pod-wide (owner-private)',
    remaining_ws, remaining_pod;
END $$;

-- 2a. Workspace-scoped uniqueness. PARTITION BY above matches this key exactly.
CREATE UNIQUE INDEX IF NOT EXISTS relations_entity_edge_ws_unique
  ON relations (source_entity_id, target_entity_id, type, workspace_id)
  WHERE source_kind = 'entity'
    AND target_kind = 'entity'
    AND source_entity_id IS NOT NULL
    AND target_entity_id IS NOT NULL
    AND workspace_id IS NOT NULL;

-- 2b. Pod-wide uniqueness, scoped to the OWNER (rows are owner-private).
CREATE UNIQUE INDEX IF NOT EXISTS relations_entity_edge_pod_unique
  ON relations (source_entity_id, target_entity_id, type, user_id)
  WHERE source_kind = 'entity'
    AND target_kind = 'entity'
    AND source_entity_id IS NOT NULL
    AND target_entity_id IS NOT NULL
    AND workspace_id IS NULL;
