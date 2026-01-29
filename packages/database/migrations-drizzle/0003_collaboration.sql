-- Migration: Collaboration
-- Description: Social features, Chat, Review Workflows (Proposals), and Notifications.

-- ============================================================================
-- 1. CHAT & MESSAGING
-- ============================================================================
CREATE TABLE IF NOT EXISTS "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
    "project_ids" uuid[], -- Optional: threads can be scoped to projects
    
	"title" text,
    "type" text DEFAULT 'direct_message' NOT NULL, -- 'group', 'channel', 'agent'
    
    -- Agent Integration
    "agent_type" text DEFAULT 'default',
    "agent_config" jsonb,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "last_message_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL REFERENCES "chat_threads"("id") ON DELETE cascade,
	"parent_id" uuid REFERENCES "conversation_messages"("id"), -- Threading
	
    "role" text NOT NULL, -- 'user', 'assistant', 'system'
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
    
	"user_id" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    
    -- Blockchain/Audit Verification (if enabled)
	"previous_hash" text,
	"hash" text,
    
	"deleted_at" timestamp with time zone
);

-- Context Links (What is discussed in the thread)
CREATE TABLE IF NOT EXISTS "thread_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL REFERENCES "chat_threads"("id") ON DELETE cascade,
	"entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
    "relationship_type" text NOT NULL, -- 'mentioned', 'context'
    "source_message_id" uuid REFERENCES "conversation_messages"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "thread_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL REFERENCES "chat_threads"("id") ON DELETE cascade,
	"document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE cascade,
    "relationship_type" text NOT NULL,
    "source_message_id" uuid REFERENCES "conversation_messages"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ============================================================================
-- 2. REVIEW FLOW (Unified Proposals)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
    "project_ids" uuid[], -- Optional: proposals can be scoped to projects
    
    -- Target (What is being proposed?)
	"target_type" text NOT NULL, -- 'document', 'entity', 'permission', 'merged'
	"target_id" text NOT NULL, -- UUID or other ID
    
    -- Concept
    "proposal_type" text NOT NULL, -- 'edit', 'comment', 'review_request'
	"data" jsonb NOT NULL, -- Detailed payload (diffs, new content, etc.)
    
	"status" text DEFAULT 'pending' NOT NULL, -- 'pending', 'approved', 'rejected', 'merged'
    
    -- Actors
    "created_by" text NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
    
    -- Feedback
	"rejection_reason" text,
    "comments" jsonb DEFAULT '[]'::jsonb,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_proposals_status" ON "proposals" ("workspace_id", "status");
CREATE INDEX "idx_proposals_target" ON "proposals" ("target_type", "target_id");

-- ============================================================================
-- 3. NOTIFICATIONS (Inbox)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
    "project_ids" uuid[], -- Optional: items can be related to projects
	"user_id" text NOT NULL,
	
    "type" text NOT NULL, -- 'mention', 'assignment', 'proposal_review'
	"title" text NOT NULL,
	"summary" text,
    "link" text,
    
    "read_at" timestamp with time zone,
    "archived_at" timestamp with time zone,
    
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "expire_at" timestamp with time zone
);

CREATE INDEX "idx_inbox_user" ON "inbox_items" ("user_id", "read_at");
