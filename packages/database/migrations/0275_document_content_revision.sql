-- 0275 — documents.content_revision + documents.working_state_revision
--
-- Documents-centerpiece W4a (the content write plane). Two different questions
-- used to share ONE column, `current_version`:
--   * "has the content changed since I read it?" (optimistic concurrency), and
--   * "which checkpoint is the latest one in the history rail?".
-- A human autosave changes the content but must NOT cut a history row every
-- 500 ms, so it never bumped `current_version`, and a proposal drafted against
-- version N silently overwrote the human's later edits at approval.
--
-- `content_revision` answers the first question. It is bumped by EVERY content
-- write, and only inside `claimDocumentRevision` (@synap/database), which is
-- the one content-write door. `current_version` keeps its meaning as the
-- last CHECKPOINT (history rail, retrieval join, whiteboard snapshots are
-- unaffected).
--
-- `working_state_revision` is the `content_revision` the Yjs cache in
-- `working_state` is KNOWN to equal. A realtime room loads `working_state` only
-- when the two match; any other writer (approval, restore, a non-collaborative
-- save) moves `content_revision` past it, so a stale Yjs cache can never be
-- loaded over newer markdown. NULL = no trustworthy cache.
--
-- No backfill: every existing row starts at revision 1 with no trusted cache
-- (the realtime room re-seeds from the markdown once).

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "content_revision" integer NOT NULL DEFAULT 1;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "working_state_revision" integer;
