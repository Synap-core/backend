-- Migration: 0008_add_entity_templates.sql

-- ============================================================================
-- Entity Templates Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS "entity_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  
  -- Scope: User OR Workspace (mutually exclusive)
  "user_id" text,
  "workspace_id" uuid,
  
  -- Target Configuration
  "target_type" text NOT NULL,
  "entity_type" text,       -- For target_type='entity'
  "inbox_item_type" text,   -- For target_type='inbox_item'
  
  -- Template Configuration (JSONB)
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  
  -- Metadata
  "is_default" boolean DEFAULT false NOT NULL,
  "is_public" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  
  -- Constraints
  CONSTRAINT "target_type_check" CHECK (target_type IN ('entity', 'document', 'project', 'inbox_item')),
  
  CONSTRAINT "valid_entity_type" CHECK (
    (target_type = 'entity' AND entity_type IS NOT NULL AND inbox_item_type IS NULL) OR
    (target_type = 'inbox_item' AND inbox_item_type IS NOT NULL AND entity_type IS NULL) OR
    (target_type NOT IN ('entity', 'inbox_item') AND entity_type IS NULL AND inbox_item_type IS NULL)
  ),
  
  CONSTRAINT "valid_scope" CHECK (
    (user_id IS NOT NULL AND workspace_id IS NULL) OR
    (user_id IS NULL AND workspace_id IS NOT NULL)
  )
);

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_templates_user" ON "entity_templates"(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_templates_workspace" ON "entity_templates"(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_templates_target_type" ON "entity_templates"(target_type);
CREATE INDEX IF NOT EXISTS "idx_templates_entity_type" ON "entity_templates"(entity_type) WHERE entity_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_templates_inbox_type" ON "entity_templates"(inbox_item_type) WHERE inbox_item_type IS NOT NULL;
-- Partial unique index to enforce one default per scope
CREATE UNIQUE INDEX IF NOT EXISTS "idx_templates_is_default" ON "entity_templates"(user_id, workspace_id, target_type, entity_type, inbox_item_type) WHERE is_default = true;

-- Foreign Keys
DO $$ BEGIN
  ALTER TABLE "entity_templates" ADD CONSTRAINT "entity_templates_workspace_id_workspaces_id_fk" 
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") 
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
