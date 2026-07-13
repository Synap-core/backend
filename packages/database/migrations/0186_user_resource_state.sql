-- 0186_user_resource_state.sql
-- Expand-compatible resource state. Keep the legacy physical table/columns so
-- the previous backend remains valid throughout canary rollout and rollback.

-- Repair pre-release environments that ran the earlier rename draft.
DO $$
BEGIN
  IF to_regclass('public.user_entity_state') IS NULL
     AND to_regclass('public.user_resource_state') IS NOT NULL THEN
    ALTER TABLE "user_resource_state" RENAME TO "user_entity_state";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_entity_state'
      AND column_name = 'resource_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_entity_state'
      AND column_name = 'item_id'
  ) THEN
    ALTER TABLE "user_entity_state" RENAME COLUMN "resource_id" TO "item_id";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_entity_state'
      AND column_name = 'resource_type'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_entity_state'
      AND column_name = 'item_type'
  ) THEN
    ALTER TABLE "user_entity_state" RENAME COLUMN "resource_type" TO "item_type";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_entity_state'
      AND column_name = 'last_opened_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_entity_state'
      AND column_name = 'last_viewed_at'
  ) THEN
    ALTER TABLE "user_entity_state" RENAME COLUMN "last_opened_at" TO "last_viewed_at";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_entity_state'
      AND column_name = 'open_count'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_entity_state'
      AND column_name = 'view_count'
  ) THEN
    ALTER TABLE "user_entity_state" RENAME COLUMN "open_count" TO "view_count";
  END IF;
END $$;

ALTER TABLE "user_entity_state"
  ADD COLUMN IF NOT EXISTS "semantic_size" varchar(20);

UPDATE "user_entity_state"
SET "starred" = COALESCE("starred", false),
    "pinned" = COALESCE("pinned", false),
    "view_count" = COALESCE("view_count", 0);

ALTER TABLE "user_entity_state"
  ALTER COLUMN "starred" SET DEFAULT false,
  ALTER COLUMN "starred" SET NOT NULL,
  ALTER COLUMN "pinned" SET DEFAULT false,
  ALTER COLUMN "pinned" SET NOT NULL,
  ALTER COLUMN "view_count" SET DEFAULT 0,
  ALTER COLUMN "view_count" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_resource_state_semantic_size_check'
      AND conrelid = 'user_entity_state'::regclass
  ) THEN
    ALTER TABLE "user_entity_state"
      ADD CONSTRAINT "user_resource_state_semantic_size_check"
      CHECK ("semantic_size" IS NULL OR "semantic_size" IN ('small', 'medium', 'large'));
  END IF;
END $$;
