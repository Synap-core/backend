-- Migration: Fix chat_threads column defaults
-- Description: Ensures agent_id and agent_type have proper defaults set in database
-- Date: 2026-02-03

-- ============================================================================
-- CHAT_THREADS DEFAULTS FIX
-- ============================================================================

-- Step 1: Ensure agent_id has default value set
DO $$
BEGIN
    -- If column exists but doesn't have default, set it
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'chat_threads' 
               AND column_name = 'agent_id'
               AND column_default IS NULL) THEN
        ALTER TABLE "chat_threads" ALTER COLUMN "agent_id" SET DEFAULT 'orchestrator';
    END IF;

    -- Backfill any NULL values with default
    UPDATE "chat_threads"
    SET "agent_id" = 'orchestrator'
    WHERE "agent_id" IS NULL;
END $$;

-- Step 2: Ensure agent_type has default value set
DO $$
BEGIN
    -- If column exists but doesn't have default, set it
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'chat_threads' 
               AND column_name = 'agent_type'
               AND column_default IS NULL) THEN
        ALTER TABLE "chat_threads" ALTER COLUMN "agent_type" SET DEFAULT 'default';
    END IF;

    -- Backfill any NULL values with default
    UPDATE "chat_threads"
    SET "agent_type" = 'default'
    WHERE "agent_type" IS NULL;
END $$;

-- Step 3: Ensure status has default value set
DO $$
BEGIN
    -- If column exists but doesn't have default, set it
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'chat_threads' 
               AND column_name = 'status'
               AND column_default IS NULL) THEN
        ALTER TABLE "chat_threads" ALTER COLUMN "status" SET DEFAULT 'active';
    END IF;

    -- Backfill any NULL values with default
    UPDATE "chat_threads"
    SET "status" = 'active'
    WHERE "status" IS NULL;
END $$;

-- Step 4: Ensure thread_type has default value set
DO $$
BEGIN
    -- If column exists but doesn't have default, set it
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'chat_threads' 
               AND column_name = 'thread_type'
               AND column_default IS NULL) THEN
        ALTER TABLE "chat_threads" ALTER COLUMN "thread_type" SET DEFAULT 'main';
    END IF;

    -- Backfill any NULL values with default
    UPDATE "chat_threads"
    SET "thread_type" = 'main'
    WHERE "thread_type" IS NULL;
END $$;

-- ============================================================================
-- NOTES
-- ============================================================================
-- This migration ensures that all required columns with defaults in the schema
-- have their defaults properly set in the database. This prevents insert errors
-- when Drizzle tries to use the default keyword but the database doesn't have
-- the default value configured.
