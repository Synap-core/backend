-- Migration: Add user preferences columns for theme, templates, and entity customization
-- Created: 2024-01-04

-- Add new JSONB columns for user preferences
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS custom_theme JSONB;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS default_templates JSONB;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS custom_entity_types JSONB;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS entity_metadata_schemas JSONB;

-- Add column comments for documentation
COMMENT ON COLUMN user_preferences.custom_theme IS 'User custom Tamagui theme overrides (colors, spacing, radii, animations)';
COMMENT ON COLUMN user_preferences.default_templates IS 'Default template IDs per entity type (e.g., {"document": "notion-like", "note": "classic-note"})';
COMMENT ON COLUMN user_preferences.custom_entity_types IS 'User-defined custom entity types with metadata schemas';
COMMENT ON COLUMN user_preferences.entity_metadata_schemas IS 'Custom metadata field definitions per entity type';
