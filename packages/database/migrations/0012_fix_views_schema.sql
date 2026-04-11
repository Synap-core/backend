-- Migration: Fix views schema alignment
-- Description: Aligns views table with current schema definition while preserving migration-only columns
-- Date: 2026-02-03

-- ============================================================================
-- VIEWS SCHEMA ALIGNMENT
-- ============================================================================

-- Step 1: Add missing columns from schema (if they don't exist)
DO $$ 
BEGIN
    -- Add description (nullable, text) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'description') THEN
        ALTER TABLE "views" ADD COLUMN "description" text;
    END IF;

    -- Add metadata (jsonb, default '{}', not null) - from schema
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'metadata') THEN
        ALTER TABLE "views" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
    END IF;

    -- Ensure filter column exists (from migration, now in schema)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'filter') THEN
        ALTER TABLE "views" ADD COLUMN "filter" jsonb DEFAULT '{}'::jsonb;
    END IF;

    -- Ensure sort column exists (from migration, now in schema)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'sort') THEN
        ALTER TABLE "views" ADD COLUMN "sort" jsonb DEFAULT '{}'::jsonb;
    END IF;

    -- Ensure columns column exists (from migration, now in schema)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'columns') THEN
        ALTER TABLE "views" ADD COLUMN "columns" jsonb DEFAULT '[]'::jsonb;
    END IF;

    -- Ensure layout_config column exists (from migration, now in schema)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'views' AND column_name = 'layout_config') THEN
        ALTER TABLE "views" ADD COLUMN "layout_config" jsonb DEFAULT '{}'::jsonb;
    END IF;
END $$;

-- Step 2: Ensure workspace_id is nullable (schema allows it to be nullable)
DO $$ 
BEGIN
    -- Check if workspace_id is NOT NULL and make it nullable if needed
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'views' 
               AND column_name = 'workspace_id' 
               AND is_nullable = 'NO') THEN
        -- Make it nullable to match schema (but keep foreign key constraint)
        ALTER TABLE "views" ALTER COLUMN "workspace_id" DROP NOT NULL;
    END IF;
END $$;

-- Step 3: Ensure yjs_room_id and thumbnail_url are nullable (schema allows them to be nullable)
DO $$ 
BEGIN
    -- Make yjs_room_id nullable if it's not
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'views' 
               AND column_name = 'yjs_room_id' 
               AND is_nullable = 'NO') THEN
        ALTER TABLE "views" ALTER COLUMN "yjs_room_id" DROP NOT NULL;
    END IF;

    -- Make thumbnail_url nullable if it's not
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'views' 
               AND column_name = 'thumbnail_url' 
               AND is_nullable = 'NO') THEN
        ALTER TABLE "views" ALTER COLUMN "thumbnail_url" DROP NOT NULL;
    END IF;
END $$;

-- ============================================================================
-- NOTES
-- ============================================================================
-- This migration:
-- 1. Adds missing columns from schema (description, metadata)
-- 2. Ensures structured configuration columns exist (filter, sort, columns, layout_config)
-- 3. These columns are now part of the schema for better querying and indexing
-- 4. Ensures nullable columns match schema definition
