-- 0382 — focus_sessions.stage_history: the stage LEDGER of a session
-- (status-first plan 4ed2a4b8, wave 1 PR-E; effects 4928e33b change 4).
--
-- Every stage a session ENTERS, oldest first, with who moved it and when:
-- the same shape as a goal's `project_tracks.stage_history` (0274). It is
-- appended where `current_stage` is written (the stage door
-- `advanceSessionStage`, and the approval re-applies), so an entry exists iff
-- the move landed.
--
-- Why a column and NOT the lifecycle transition outbox: `listHolds` reads the
-- subject's LATEST transition whatever its property, so a stage row there
-- would hide a paused session's hold and `since` (effects finding 2).
--
-- No backfill: the ledger starts empty; a read says "not recorded before".
-- Column only, idempotent.

ALTER TABLE "focus_sessions"
  ADD COLUMN IF NOT EXISTS "stage_history" jsonb NOT NULL DEFAULT '[]'::jsonb;
