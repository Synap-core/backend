-- 0245_artifacts_workspace_nullable.sql
--
-- A pod-personal session may have pod-personal outputs.
--
-- `focus_sessions.workspace_id` has always been nullable — a session can be
-- pod-personal (or project-only), and most of a founder's sessions are exactly
-- that. `artifacts.workspace_id` was NOT NULL (0125), so the ONE ledger that
-- records "this session produced that object" could not hold a row for those
-- sessions at all. Both write doors (`focusSessions.attachOutput` and
-- `POST /focus-sessions/:id/outputs`) therefore REFUSED — the session room's
-- whole purpose, recording what the session produced, was off for the majority
-- of sessions. The `produced` LINK ledger has no such constraint, so entities
-- recorded fine while documents / views / whiteboards did not: the same room,
-- two different answers, decided by a column constraint nobody chose.
--
-- The honest model is the one `focus_sessions`, `entities`, `documents` and
-- `channels` already use: NULL workspace = pod-personal, floored to its OWNER.
-- The access-layer `VisibilityRule` for `artifacts` moves from `podGlobalConfig`
-- to an owner floor on NULL rows in the same wave (access/registry.ts) — a
-- pod-personal artifact is private data, never pod-wide substrate.
--
-- WIDENING ONLY. Dropping NOT NULL cannot invalidate an existing row, so this
-- is safe to re-run and safe on a populated table. No backfill: every existing
-- artifact keeps the workspace it was filed under.

ALTER TABLE IF EXISTS "artifacts"
  ALTER COLUMN "workspace_id" DROP NOT NULL;
