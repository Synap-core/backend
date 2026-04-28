-- Add metadata JSONB column to source_configs for archetype tagging
ALTER TABLE source_configs ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';
