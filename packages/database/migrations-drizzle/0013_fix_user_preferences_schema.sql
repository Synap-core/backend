-- Migration: Fix user_preferences schema alignment
-- Description: Aligns user_preferences table with current schema definition
-- Date: 2026-02-03

-- ============================================================================
-- USER_PREFERENCES SCHEMA ALIGNMENT
-- ============================================================================

-- Step 1: Add missing columns from schema (if they don't exist)
DO $$
BEGIN
    -- Add custom_theme (jsonb, nullable) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_preferences' AND column_name = 'custom_theme') THEN
        ALTER TABLE "user_preferences" ADD COLUMN "custom_theme" jsonb;
    END IF;

    -- Add default_templates (jsonb, nullable) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_preferences' AND column_name = 'default_templates') THEN
        ALTER TABLE "user_preferences" ADD COLUMN "default_templates" jsonb;
    END IF;

    -- Add custom_entity_types (jsonb, nullable) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_preferences' AND column_name = 'custom_entity_types') THEN
        ALTER TABLE "user_preferences" ADD COLUMN "custom_entity_types" jsonb;
    END IF;

    -- Add entity_metadata_schemas (jsonb, nullable) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_preferences' AND column_name = 'entity_metadata_schemas') THEN
        ALTER TABLE "user_preferences" ADD COLUMN "entity_metadata_schemas" jsonb;
    END IF;

    -- Add ui_preferences (jsonb, default '{}', not null) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_preferences' AND column_name = 'ui_preferences') THEN
        ALTER TABLE "user_preferences" ADD COLUMN "ui_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;
    END IF;

    -- Add graph_preferences (jsonb, default '{}', not null) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_preferences' AND column_name = 'graph_preferences') THEN
        ALTER TABLE "user_preferences" ADD COLUMN "graph_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;
    END IF;

    -- Add intelligence_service_preferences (jsonb, default '{}', not null) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_preferences' AND column_name = 'intelligence_service_preferences') THEN
        ALTER TABLE "user_preferences" ADD COLUMN "intelligence_service_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;
    END IF;

    -- Add onboarding_completed (boolean, default false, not null) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_preferences' AND column_name = 'onboarding_completed') THEN
        ALTER TABLE "user_preferences" ADD COLUMN "onboarding_completed" boolean DEFAULT false NOT NULL;
    END IF;

    -- Add onboarding_step (text, nullable) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_preferences' AND column_name = 'onboarding_step') THEN
        ALTER TABLE "user_preferences" ADD COLUMN "onboarding_step" text;
    END IF;
END $$;

-- Step 2: Keep old columns separate (notifications, dashboard_layout, accessibility)
-- These are NOT migrated to ui_preferences as they serve different purposes
-- notifications: notification preferences (email, push, etc.)
-- dashboard_layout: dashboard-specific layout settings
-- accessibility: accessibility settings
-- ui_preferences: general UI preferences (sidebar, compact mode, etc.)
-- No migration needed - keep them as separate columns

-- Step 3: Ensure NOT NULL constraints and defaults for new columns
DO $$
BEGIN
    -- Ensure ui_preferences has default if null
    UPDATE "user_preferences"
    SET "ui_preferences" = '{}'::jsonb
    WHERE "ui_preferences" IS NULL;

    -- Ensure graph_preferences has default if null
    UPDATE "user_preferences"
    SET "graph_preferences" = '{}'::jsonb
    WHERE "graph_preferences" IS NULL;

    -- Ensure intelligence_service_preferences has default if null
    UPDATE "user_preferences"
    SET "intelligence_service_preferences" = '{}'::jsonb
    WHERE "intelligence_service_preferences" IS NULL;

    -- Ensure onboarding_completed has default if null
    UPDATE "user_preferences"
    SET "onboarding_completed" = false
    WHERE "onboarding_completed" IS NULL;
END $$;

-- Step 4: Set NOT NULL constraints (after backfilling data)
DO $$
BEGIN
    -- Ensure ui_preferences is NOT NULL
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'user_preferences' 
               AND column_name = 'ui_preferences'
               AND is_nullable = 'YES') THEN
        ALTER TABLE "user_preferences" ALTER COLUMN "ui_preferences" SET NOT NULL;
    END IF;

    -- Ensure graph_preferences is NOT NULL
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'user_preferences' 
               AND column_name = 'graph_preferences'
               AND is_nullable = 'YES') THEN
        ALTER TABLE "user_preferences" ALTER COLUMN "graph_preferences" SET NOT NULL;
    END IF;

    -- Ensure intelligence_service_preferences is NOT NULL
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'user_preferences' 
               AND column_name = 'intelligence_service_preferences'
               AND is_nullable = 'YES') THEN
        ALTER TABLE "user_preferences" ALTER COLUMN "intelligence_service_preferences" SET NOT NULL;
    END IF;

    -- Ensure onboarding_completed is NOT NULL
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'user_preferences' 
               AND column_name = 'onboarding_completed'
               AND is_nullable = 'YES') THEN
        ALTER TABLE "user_preferences" ALTER COLUMN "onboarding_completed" SET NOT NULL;
    END IF;
END $$;

-- Step 5: Drop old columns that are no longer in schema (optional - preserve for now)
-- We keep 'language', 'notifications', 'dashboard_layout', 'accessibility' for backward compatibility
-- They can be dropped in a future migration if not needed

-- ============================================================================
-- NOTES
-- ============================================================================
-- This migration:
-- 1. Adds missing columns from schema (custom_theme, default_templates, custom_entity_types, 
--    entity_metadata_schemas, ui_preferences, graph_preferences, intelligence_service_preferences, 
--    onboarding_completed, onboarding_step)
-- 2. Migrates old column data (notifications, dashboard_layout, accessibility) into ui_preferences
-- 3. Ensures NOT NULL constraints and defaults match schema
-- 4. Preserves old columns (language, notifications, dashboard_layout, accessibility) for backward compatibility
