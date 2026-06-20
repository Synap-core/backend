-- Generalize the pod-wide tool uniqueness invariant beyond Nango.
--
-- BACKGROUND: mig 0132 added a partial unique index on `tools (credential_ref)`
-- scoped to `credential_ref LIKE 'nango://%' AND workspace_id IS NULL`, making
-- connectors.syncToolRows race-safe (ON CONFLICT DO NOTHING) so concurrent syncs
-- can't create duplicate pod-wide provider rows.
--
-- INVARIANT (root-caused from the create paths): the canonical pod-wide dedup key
-- is `credential_ref` itself — syncToolRows dedupes on exactly
-- `(credential_ref, workspace_id IS NULL)`. The `nango://%` clause was an
-- implementation-specific narrowing, not part of the real invariant. Generalizing
-- to ANY non-null credential_ref gives non-Nango pod-wide credentialed tools
-- (vault://, mcp://, future schemes) the SAME race-safety.
--
-- WHY NOT a blanket UNIQUE(credential_ref): builtin/script/internal tools
-- legitimately carry `credential_ref = NULL` and must never collide. The
-- `credential_ref IS NOT NULL` predicate excludes them explicitly (NULLs are
-- already distinct in a Postgres unique index, but the predicate makes intent
-- clear and keeps the partial index minimal). Workspace-scoped tools
-- (workspace_id NOT NULL) are likewise out of scope — pod-wide identity only.
--
-- Defensive: drop the old narrow index, de-dup any pre-existing collisions
-- (keep the earliest row per credential_ref), then create the generalized index.

-- 1) Collapse any pre-existing pod-wide duplicates so the new unique index can
--    be created. Keep the earliest-created row per (credential_ref); delete the
--    rest. (No-op on a clean pod; defensive for pods that materialized dups while
--    only the narrow nango:// index existed.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'tools'
  ) THEN
    DELETE FROM tools t
    USING tools keep
    WHERE t.workspace_id IS NULL
      AND keep.workspace_id IS NULL
      AND t.credential_ref IS NOT NULL
      AND t.credential_ref = keep.credential_ref
      AND (
        keep.created_at < t.created_at
        OR (keep.created_at = t.created_at AND keep.id < t.id)
      );
  END IF;
END;
$$;

-- 2) Replace the Nango-specific index with the scheme-agnostic generalization.
DROP INDEX IF EXISTS idx_tools_provider_cred;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_podwide_credential_ref
  ON tools (credential_ref)
  WHERE credential_ref IS NOT NULL AND workspace_id IS NULL;
