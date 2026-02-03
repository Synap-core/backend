-- Migration: Fix chat_threads schema alignment
-- Description: Aligns chat_threads table with current schema definition while preserving migration-only columns
-- Date: 2026-02-03

-- ============================================================================
-- CHAT_THREADS SCHEMA ALIGNMENT
-- ============================================================================

-- Step 1: Add missing columns from schema (if they don't exist)
DO $$ 
BEGIN
    -- Add user_id (required by schema, not null)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'chat_threads' AND column_name = 'user_id') THEN
        ALTER TABLE "chat_threads" ADD COLUMN "user_id" text;
        -- Set a default for existing rows (will need to be updated manually if needed)
        UPDATE "chat_threads" SET "user_id" = 'system' WHERE "user_id" IS NULL;
        ALTER TABLE "chat_threads" ALTER COLUMN "user_id" SET NOT NULL;
    END IF;

    -- Add status (required by schema, enum: 'active', 'merged', 'archived')
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'chat_threads' AND column_name = 'status') THEN
        ALTER TABLE "chat_threads" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;
        -- Add check constraint for enum values
        ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_status_check" 
            CHECK ("status" IN ('active', 'merged', 'archived'));
    END IF;

    -- Add parent_thread_id (nullable, for branching)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'chat_threads' AND column_name = 'parent_thread_id') THEN
        ALTER TABLE "chat_threads" ADD COLUMN "parent_thread_id" uuid;
        -- Add foreign key constraint
        ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_parent_thread_id_fkey" 
            FOREIGN KEY ("parent_thread_id") REFERENCES "chat_threads"("id") ON DELETE SET NULL;
    END IF;

    -- Add branched_from_message_id (nullable, for branching)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'chat_threads' AND column_name = 'branched_from_message_id') THEN
        ALTER TABLE "chat_threads" ADD COLUMN "branched_from_message_id" uuid;
        -- Add foreign key constraint (if conversation_messages table exists)
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'conversation_messages') THEN
            ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_branched_from_message_id_fkey" 
                FOREIGN KEY ("branched_from_message_id") REFERENCES "conversation_messages"("id") ON DELETE SET NULL;
        END IF;
    END IF;

    -- Add branch_purpose (nullable, text)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'chat_threads' AND column_name = 'branch_purpose') THEN
        ALTER TABLE "chat_threads" ADD COLUMN "branch_purpose" text;
    END IF;

    -- Add agent_id (required by schema, default 'orchestrator')
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'chat_threads' AND column_name = 'agent_id') THEN
        ALTER TABLE "chat_threads" ADD COLUMN "agent_id" text DEFAULT 'orchestrator' NOT NULL;
    END IF;

    -- Add context_summary (nullable, text)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'chat_threads' AND column_name = 'context_summary') THEN
        ALTER TABLE "chat_threads" ADD COLUMN "context_summary" text;
    END IF;

    -- Add metadata (nullable, jsonb)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'chat_threads' AND column_name = 'metadata') THEN
        ALTER TABLE "chat_threads" ADD COLUMN "metadata" jsonb;
    END IF;

    -- Add merged_at (nullable, timestamp)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'chat_threads' AND column_name = 'merged_at') THEN
        ALTER TABLE "chat_threads" ADD COLUMN "merged_at" timestamp with time zone;
    END IF;
END $$;

-- Step 2: Rename 'type' to 'thread_type' and update enum values
DO $$ 
BEGIN
    -- Check if 'type' column exists and 'thread_type' doesn't
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'chat_threads' AND column_name = 'type')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'chat_threads' AND column_name = 'thread_type') THEN
        
        -- Rename column
        ALTER TABLE "chat_threads" RENAME COLUMN "type" TO "thread_type";
        
        -- Update existing values to match schema enum ('main' | 'branch')
        -- Map old values: 'direct_message' -> 'main', 'group' -> 'main', 'channel' -> 'main', 'agent' -> 'main'
        UPDATE "chat_threads" 
        SET "thread_type" = 'main' 
        WHERE "thread_type" IN ('direct_message', 'group', 'channel', 'agent');
        
        -- Set default to 'main' (schema default)
        ALTER TABLE "chat_threads" ALTER COLUMN "thread_type" SET DEFAULT 'main';
        ALTER TABLE "chat_threads" ALTER COLUMN "thread_type" SET NOT NULL;
        
        -- Add check constraint for enum values
        ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_thread_type_check" 
            CHECK ("thread_type" IN ('main', 'branch'));
    END IF;
END $$;

-- Step 3: Update agent_type enum constraint to match schema
DO $$ 
BEGIN
    -- Remove old constraint if it exists
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints 
               WHERE table_name = 'chat_threads' 
               AND constraint_name = 'chat_threads_agent_type_check') THEN
        ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_agent_type_check";
    END IF;
    
    -- Add new constraint matching schema enum values
    ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_agent_type_check" 
        CHECK ("agent_type" IN ('default', 'meta', 'prompting', 'knowledge-search', 'code', 'writing', 'action'));
END $$;

-- Step 4: Create/update indexes as per schema
CREATE INDEX IF NOT EXISTS "chat_threads_user_id_idx" ON "chat_threads" ("user_id");
CREATE INDEX IF NOT EXISTS "chat_threads_parent_thread_id_idx" ON "chat_threads" ("parent_thread_id");
CREATE INDEX IF NOT EXISTS "chat_threads_project_ids_idx" ON "chat_threads" USING GIN ("project_ids");
CREATE INDEX IF NOT EXISTS "chat_threads_status_idx" ON "chat_threads" ("status");

-- Step 5: Ensure workspace_id and last_message_at are preserved (migration-only columns)
-- These columns exist in migration but not in schema - we keep them as requested
-- No action needed - they already exist from 0003_collaboration.sql

-- ============================================================================
-- NOTES
-- ============================================================================
-- This migration:
-- 1. Uses schema naming (user_id, thread_type, status, etc.)
-- 2. Preserves migration-only columns (workspace_id, last_message_at)
-- 3. Adds all missing columns from schema
-- 4. Updates enum constraints to match schema
-- 5. Creates required indexes
