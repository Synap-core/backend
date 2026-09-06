-- ── Artifacts — session output-ledger idempotency ────────────────────────────
--
-- WHY NOW: both attach-output doors (`focusSessions.attachOutput` and
-- `POST /focus-sessions/:id/outputs`) did a PLAIN INSERT into `artifacts`, and
-- nothing in the table stopped a repeat. A retry after a failed request, or a
-- double-click on "record this as an output", wrote a SECOND provenance row
-- asserting the same fact — and `listSessionOutputs` then showed the same
-- object twice in the session room, with no way for the user to tell which row
-- to remove. Provenance is a statement about what happened; stating it twice is
-- not two facts.
--
-- ── The KEY includes the declared-slot claim, deliberately ───────────────────
--
-- `artifacts.props.expectedLabel` names WHICH declared `expectedOutputs[]` slot
-- an attached object is claimed against. The SAME document may legitimately
-- satisfy two different slots ("Spec" and "Hand-off note"), so a key of
-- (session_id, kind, ref_id) alone would silently swallow the second claim —
-- turning an idempotency guard into data loss. The label is therefore part of
-- the key.
--
-- `COALESCE(..., '')` because a unique index treats NULLs as DISTINCT: without
-- it, every unlabelled row would be exempt from uniqueness, which is precisely
-- the common case this index exists to dedupe.
--
-- PARTIAL on `session_id IS NOT NULL AND ref_id IS NOT NULL`: a desk artifact
-- with no session is not an output, and a `cell` artifact has no `ref_id` at
-- all (its backing object is inline). Neither participates.
--
-- ⚠️ THIS MIGRATION DELETES ROWS. Blast radius, on a snapshot first:
--
--   SELECT session_id, kind, ref_id, COALESCE(props->>'expectedLabel','') AS slot,
--          count(*)
--   FROM artifacts
--   WHERE session_id IS NOT NULL AND ref_id IS NOT NULL
--   GROUP BY 1,2,3,4 HAVING count(*) > 1;
--
-- Dedupe keeps the EARLIEST row (created_at, then id as a stable tie-break), so
-- the survivor retains the original provenance columns (origin_kind / actor_id)
-- — the first claim about who produced the object is the true one.
--
-- Defensive / idempotent on re-run.

-- 1. Collapse existing duplicates to the earliest row per key.
DELETE FROM artifacts a
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY session_id, kind, ref_id,
                        COALESCE(props->>'expectedLabel', '')
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM artifacts
  WHERE session_id IS NOT NULL
    AND ref_id IS NOT NULL
) dupes
WHERE a.id = dupes.id
  AND dupes.rn > 1;

-- 2. Report what step 1 removed. Migrations run UNATTENDED at pod startup, so
-- the "inspect first" note above cannot be followed on a real deploy; without
-- this, rows vanish with no record an operator can later consult.
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM artifacts
  WHERE session_id IS NOT NULL AND ref_id IS NOT NULL;
  RAISE NOTICE '[0246] artifacts session-output dedupe complete — % session-output rows remain', remaining;
END $$;

-- 3. The guard itself. PARTITION BY above matches this key exactly.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_session_ref_unique
  ON artifacts (
    session_id,
    kind,
    ref_id,
    (COALESCE(props->>'expectedLabel', ''))
  )
  WHERE session_id IS NOT NULL
    AND ref_id IS NOT NULL;
