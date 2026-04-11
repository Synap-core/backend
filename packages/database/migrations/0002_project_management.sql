-- Migration: Project Management
-- Description: Structures for managing work: Projects, Teams, and Visualization Views.

-- ============================================================================
-- 1. PROJECTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
    "color" text,
    "status" text DEFAULT 'active',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"user_id" text NOT NULL,
	"role" text NOT NULL, -- 'lead', 'member', 'viewer'
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ============================================================================
-- 2. VISUALIZATION (Views)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
    "project_ids" uuid[], -- Optional: views can be scoped to projects
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL, -- 'kanban', 'list', 'calendar', 'graph'
    "category" text DEFAULT 'custom',
    
    -- Configuration
	"filter" jsonb DEFAULT '{}'::jsonb, -- dynamic filters
	"sort" jsonb DEFAULT '{}'::jsonb,
    "columns" jsonb DEFAULT '[]'::jsonb,
    "layout_config" jsonb DEFAULT '{}'::jsonb,

    -- Interactive State
    "yjs_room_id" text,
    "thumbnail_url" text,

    -- Linked Document (if view is embedded in a doc)
    "document_id" uuid REFERENCES "documents"("id") ON DELETE set null,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
