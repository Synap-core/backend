-- 0317_project_tracks_live_name_unique.sql
--
-- A project can run the same METHOD more than once (founder decision D1,
-- 2026-10-11): a track's identity on its project is its NAME, not its method.
--
--   before  uniq_project_tracks_live_method  (project_id, playbook_id)
--           WHERE status <> 'archived' AND playbook_id IS NOT NULL
--           — a COMPLETED track still held the method's slot, so a method
--             could never be run a second time without archiving the first.
--   after   uniq_project_tracks_live_name    (project_id, lower(btrim(name)))
--           WHERE status IN ('active', 'paused')
--           — only LIVE tracks hold a name; completed and archived hold nothing.
--
-- The name defaults to the method's name (`startTrack`), so starting the same
-- method twice WITHOUT a name stays idempotent (the live track comes back as
-- `exists`); starting it under another name creates a second track.
--
-- A failed migration aborts pod boot, so the dedupe below must never fail and
-- loses nothing. The old index allowed two live tracks to share a name when
-- they ran DIFFERENT methods (a track named after another method, or two
-- methods of the same name). For each such group the OLDEST live track
-- (created_at, then id) keeps its name; every other one is renamed
-- "<name> (2)", "(3)"… — each candidate checked free against the project's
-- live names first. Every rename is RAISE NOTICE'd. Idempotent: a re-run finds
-- no duplicates. Mirrored by the Drizzle schema (`project-tracks.ts`) and
-- required at boot by `findMissingIndexes` (schema-coherence.ts).

DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n integer;
BEGIN
  FOR r IN
    SELECT id, project_id, name, rn
      FROM (
        SELECT id, project_id, name,
               row_number() OVER (
                 PARTITION BY project_id, lower(btrim(name))
                 ORDER BY created_at ASC NULLS LAST, id ASC
               ) AS rn
          FROM project_tracks
         WHERE status IN ('active', 'paused')
      ) ranked
     WHERE rn > 1
     ORDER BY project_id, lower(btrim(name)), rn
  LOOP
    base := btrim(r.name);
    n := r.rn;
    LOOP
      candidate := btrim(base || ' (' || n || ')');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM project_tracks
         WHERE project_id = r.project_id
           AND status IN ('active', 'paused')
           AND lower(btrim(name)) = lower(candidate)
      );
      n := n + 1;
    END LOOP;
    UPDATE project_tracks SET name = candidate, updated_at = now() WHERE id = r.id;
    RAISE NOTICE '0317: track % renamed "%" -> "%" (duplicate live name on its project)',
      r.id, r.name, candidate;
  END LOOP;
END $$;

DROP INDEX IF EXISTS "uniq_project_tracks_live_method";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_tracks_live_name"
  ON "project_tracks" ("project_id", lower(btrim("name")))
  WHERE "status" IN ('active', 'paused');
