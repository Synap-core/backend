-- Add metadata field to relations table
-- Migration: 0007_relations_metadata.sql

ALTER TABLE relations ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Add comment
COMMENT ON COLUMN relations.metadata IS 'Additional metadata for the relationship (e.g., confidence scores, notes, etc.)';
