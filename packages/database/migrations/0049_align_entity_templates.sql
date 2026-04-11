-- Align entity_templates table with current Drizzle schema
-- The schema expects: user_id, target_type, entity_type, inbox_item_type, config, is_default, is_public, version
-- The table has old columns: icon, color, default_content, is_system

-- Add missing columns
ALTER TABLE entity_templates ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE entity_templates ADD COLUMN IF NOT EXISTS target_type text;
ALTER TABLE entity_templates ADD COLUMN IF NOT EXISTS entity_type text;
ALTER TABLE entity_templates ADD COLUMN IF NOT EXISTS inbox_item_type text;
ALTER TABLE entity_templates ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE entity_templates ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE entity_templates ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE entity_templates ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- Backfill target_type for existing rows (required NOT NULL after backfill)
UPDATE entity_templates SET target_type = 'entity' WHERE target_type IS NULL;
ALTER TABLE entity_templates ALTER COLUMN target_type SET NOT NULL;

-- Make workspace_id nullable (schema allows NULL for user-scoped templates)
ALTER TABLE entity_templates ALTER COLUMN workspace_id DROP NOT NULL;

-- Make schema nullable (schema definition says no .notNull())
ALTER TABLE entity_templates ALTER COLUMN schema DROP NOT NULL;
ALTER TABLE entity_templates ALTER COLUMN schema DROP DEFAULT;

-- Drop old columns that are no longer in the Drizzle schema
ALTER TABLE entity_templates DROP COLUMN IF EXISTS icon;
ALTER TABLE entity_templates DROP COLUMN IF EXISTS color;
ALTER TABLE entity_templates DROP COLUMN IF EXISTS default_content;
ALTER TABLE entity_templates DROP COLUMN IF EXISTS is_system;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_templates_user ON entity_templates (user_id);
CREATE INDEX IF NOT EXISTS idx_templates_workspace ON entity_templates (workspace_id);
CREATE INDEX IF NOT EXISTS idx_templates_target_type ON entity_templates (target_type);
CREATE INDEX IF NOT EXISTS idx_templates_entity_type ON entity_templates (entity_type);
CREATE INDEX IF NOT EXISTS idx_templates_inbox_type ON entity_templates (inbox_item_type);

-- Add constraints
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_scope') THEN
    ALTER TABLE entity_templates ADD CONSTRAINT valid_scope CHECK (
      (user_id IS NOT NULL AND workspace_id IS NULL) OR
      (user_id IS NULL AND workspace_id IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'target_type_check') THEN
    ALTER TABLE entity_templates ADD CONSTRAINT target_type_check CHECK (
      target_type IN ('entity', 'document', 'project', 'inbox_item')
    );
  END IF;
END $$;

-- Add unique constraint (ignore if existing rows violate it)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_default_per_scope') THEN
    ALTER TABLE entity_templates ADD CONSTRAINT unique_default_per_scope
      UNIQUE (user_id, workspace_id, target_type, entity_type, inbox_item_type, is_default);
  END IF;
END $$;
