-- ============================================================================
-- 0020_pod_settings.sql — Pod-wide settings singleton row
-- ============================================================================
--
-- Adds a single-row table holding pod-wide defaults that workspaces inherit
-- when their own settings.* slot is unset. Currently stores:
--
--   • intelligenceDefaults — tier-based model defaults (chat / reasoning /
--     embedding / vision). null fields fall through to the active IS.
--   • proactiveDefaults    — pod-wide proactive AI defaults (enabled flag,
--     nudge density, schedule toggles). Workspaces can still override via
--     `workspace.settings.proactiveAi`.
--
-- Singleton-by-convention: the table can hold many rows on disk, but the
-- API only ever upserts the first row (`ORDER BY created_at LIMIT 1`).
-- We do NOT enforce singleton via a partial unique index because the
-- singleton row is created lazily on first read, not seeded eagerly.
--
-- All statements are idempotent — safe to re-apply.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "pod_settings" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "settings"   jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Defensive: ensure all columns exist on pre-existing tables.
ALTER TABLE "pod_settings" ADD COLUMN IF NOT EXISTS "settings"   jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "pod_settings" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone NOT NULL DEFAULT now();
ALTER TABLE "pod_settings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now();
