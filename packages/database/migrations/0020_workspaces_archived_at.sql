-- ============================================================================
-- 0020_workspaces_archived_at.sql — Workspace soft-archive support
-- ============================================================================
--
-- Adds `archived_at` to `workspaces` so a workspace can be soft-archived
-- (hidden from default list queries without losing its rows). Pod admins
-- (and the workspace owner) flip the timestamp via
-- `trpc.workspaces.archive` — restoring is just NULLing the column.
--
-- Pairs with:
--   • Drizzle schema:   packages/database/src/schema/workspaces.ts
--                       (workspaces.archivedAt)
--   • tRPC router:      packages/api/src/routers/workspaces.ts (archive)
--   • Schema-coherence: packages/database/src/utils/schema-coherence.ts
--   • Baseline catch-up: packages/database/migrations/0000_baseline_schema.sql
--
-- Idempotent — safe to re-apply.
-- ============================================================================

-- ─── 1. Column ──────────────────────────────────────────────────────────────
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

-- ─── 2. Index supporting "non-archived" list queries ────────────────────────
-- The default `workspaces.list` query filters `WHERE archived_at IS NULL`.
-- A partial index keeps that fast even after many workspaces are archived.
CREATE INDEX IF NOT EXISTS "workspaces_active_idx"
  ON "workspaces" ("created_at" DESC)
  WHERE "archived_at" IS NULL;
