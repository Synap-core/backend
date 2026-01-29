-- Migration: Knowledge Graph
-- Description: Defines the core data structures: Entities, Documents, Relations, and Tags.

-- ============================================================================
-- 1. CONTENT (Documents)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
    "project_ids" uuid[], -- Optional: documents can belong to multiple projects
    
	"title" text DEFAULT 'Untitled' NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE cascade,
	"content" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text
);

-- ============================================================================
-- 2. NODES (Entities)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
    "project_ids" uuid[], -- Optional: entities can belong to multiple projects

	"type" text NOT NULL, -- 'note', 'task', 'file', 'person', etc.
	"title" text,
    "slug" text,
	"preview" text,
    "metadata" jsonb DEFAULT '{}'::jsonb, -- Flexible metadata (priority, status, etc.)
    
    -- Link to Document Content (Optional 1:1)
    "document_id" uuid REFERENCES "documents"("id") ON DELETE set null,

    -- File Metadata (if type='file')
	"file_url" text,
	"file_path" text,
	"file_size" integer,
	"file_type" text,
	"checksum" text,
	
    "version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);

-- Index for fast lookup by type and user
CREATE INDEX IF NOT EXISTS "idx_entities_type" ON "entities" ("type");
CREATE INDEX IF NOT EXISTS "idx_entities_user" ON "entities" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_entities_workspace" ON "entities" ("workspace_id");

-- ============================================================================
-- 3. EDGES (Relations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
    "workspace_id" uuid NOT NULL,
    "project_ids" uuid[], -- Optional: relations can be scoped to projects

	"source_entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
	"target_entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
	"type" text NOT NULL, -- 'blocks', 'related_to', 'parent_of'
    "metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_relations_source" ON "relations" ("source_entity_id");
CREATE INDEX IF NOT EXISTS "idx_relations_target" ON "relations" ("target_entity_id");

-- ============================================================================
-- 4. ORGANIZATION (Tags)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
    "workspace_id" uuid NOT NULL,
    "project_ids" uuid[], -- Optional: tags can be scoped to projects
    
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "entity_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
	"tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    UNIQUE("entity_id", "tag_id")
);

-- ============================================================================
-- 5. TEMPLATES
-- ============================================================================
CREATE TABLE IF NOT EXISTS "entity_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"color" text,
	"schema" jsonb DEFAULT '{}'::jsonb NOT NULL, -- Defines structure/fields
    "default_content" jsonb,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
