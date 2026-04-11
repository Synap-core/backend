-- Add system_data JSONB column to entities
-- Stores system-managed state separately from user-defined properties.
-- Prevents __prefixed keys from polluting property validation and UI display.
-- Fields: viewMode ('document' | 'bento'), bentoViewId (uuid of bento view row)
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS system_data jsonb NOT NULL DEFAULT '{}';

-- Backfill: migrate __viewMode and __bentoViewId out of properties into system_data
UPDATE entities
SET
  system_data = jsonb_build_object(
    'viewMode',    properties->>'__viewMode',
    'bentoViewId', properties->>'__bentoViewId'
  ),
  properties  = properties - '__viewMode' - '__bentoViewId'
WHERE properties ? '__viewMode' OR properties ? '__bentoViewId';
