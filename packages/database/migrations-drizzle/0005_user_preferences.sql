-- Migration: User Preferences
-- Description: User-specific settings, state, and sessions.

-- ============================================================================
-- 1. SETTINGS
-- ============================================================================
CREATE TABLE IF NOT EXISTS "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
    "theme" text DEFAULT 'system',
    "language" text DEFAULT 'en',
    "notifications" jsonb DEFAULT '{}'::jsonb,
    "dashboard_layout" jsonb DEFAULT '{}'::jsonb,
    "accessibility" jsonb DEFAULT '{}'::jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ============================================================================
-- 2. STATE & INTERACTIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS "user_entity_state" (
    "user_id" text NOT NULL,
    "entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
    
    "is_favorite" boolean DEFAULT false,
    "last_viewed_at" timestamp with time zone,
    "read_progress" integer DEFAULT 0, -- Percentage
    
    PRIMARY KEY ("user_id", "entity_id")
);

CREATE TABLE IF NOT EXISTS "document_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE cascade,
	"user_id" text NOT NULL,
    
    "cursor_position" jsonb,
    "selection" jsonb,
    "active_at" timestamp with time zone DEFAULT now() NOT NULL
);
