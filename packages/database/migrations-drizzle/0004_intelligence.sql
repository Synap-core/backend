-- Migration: Intelligence
-- Description: AI capabilities, Agents, Embeddings, and Automated Insights.

-- ============================================================================
-- 1. AGENTS & SKILLS
-- ============================================================================
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL,
	"created_by" text NOT NULL,
    
	"name" text NOT NULL,
	"description" text,
    "avatar" text,
    
    -- Configuration
    "model_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "prompt_template" text,
    "tools" text[] DEFAULT '{}'::text[],
    
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "skills" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL,
    "user_id" text NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "code" text NOT NULL,
    "parameters" jsonb,
    "category" text,
    "execution_mode" text DEFAULT 'sync' NOT NULL,
    "timeout_seconds" integer DEFAULT 30,
    "status" text DEFAULT 'active' NOT NULL,
    "error_message" text,
    "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "skills_workspace_id_idx" ON "skills" ("workspace_id");

-- ============================================================================
-- 2. SEMANTIC SEARCH (Vectors)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "entity_vectors" (
	"entity_id" uuid PRIMARY KEY NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
    "user_id" text NOT NULL,
    
	"embedding" vector(1536), -- Default OpenAI size, adjustable via migration if model changes
	"embedding_model" text DEFAULT 'text-embedding-3-small' NOT NULL,
	
    -- Denormalized for fast filtering
    "entity_type" text NOT NULL,
	"title" text,
	"preview" text,
	"file_url" text,
    
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ============================================================================
-- 3. INSIGHTS & KNOWLEDGE
-- ============================================================================
CREATE TABLE IF NOT EXISTS "knowledge_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
    
	"fact" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
    "embedding" vector(1536) NOT NULL,
    
    -- Provenance
	"source_entity_id" uuid REFERENCES "entities"("id") ON DELETE set null,
	"source_message_id" uuid REFERENCES "conversation_messages"("id") ON DELETE set null,
    
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "entity_enrichments" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
    "enrichment_type" text NOT NULL,
    "source_event_id" uuid NOT NULL,
    "agent_id" text NOT NULL,
    "confidence" numeric(3, 2) NOT NULL,
    "data" jsonb NOT NULL,
    "user_id" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "entity_enrichments_entity_id_idx" ON "entity_enrichments" ("entity_id");

CREATE TABLE IF NOT EXISTS "entity_relationships" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "source_entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
    "target_entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
    "relationship_type" text NOT NULL,
    "source_event_id" uuid NOT NULL,
    "agent_id" text NOT NULL,
    "confidence" numeric(3, 2) NOT NULL,
    "context" text,
    "user_id" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    UNIQUE("source_entity_id", "target_entity_id", "relationship_type")
);

CREATE TABLE IF NOT EXISTS "reasoning_traces" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "subject_type" text NOT NULL,
    "subject_id" uuid NOT NULL,
    "source_event_id" uuid NOT NULL,
    "agent_id" text NOT NULL,
    "steps" jsonb NOT NULL,
    "outcome" jsonb NOT NULL,
    "metrics" jsonb,
    "user_id" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "ai_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL, -- 'tag', 'link', 'calendar'
	"status" text DEFAULT 'pending' NOT NULL,
	
    "title" text NOT NULL,
	"description" text NOT NULL,
	"payload" jsonb, -- Actionable data
    
	"confidence" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ============================================================================
-- 4. CONFIGURATION
-- ============================================================================
CREATE TABLE IF NOT EXISTS "intelligence_services" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL,
    "provider" text NOT NULL, -- 'openai', 'anthropic', 'local'
    "api_key_ref" text, -- Reference to stored secret
    "config" jsonb DEFAULT '{}'::jsonb,
    "is_enabled" boolean DEFAULT true NOT NULL
);
