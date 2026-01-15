-- Migration: Remove deprecated file fields from entities table
-- Date: 2026-01-15
-- Purpose: Clean up deprecated fields, entities should only reference documents via documentId

-- Check if any data exists (should be 0 based on user confirmation)
DO $$ 
DECLARE 
    file_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO file_count 
    FROM entities 
    WHERE file_url IS NOT NULL OR file_path IS NOT NULL;
    
    IF file_count > 0 THEN
        RAISE NOTICE 'Warning: % entities have file data that will be lost', file_count;
    ELSE
        RAISE NOTICE 'Safe to proceed: No entities have deprecated file fields';
    END IF;
END $$;

-- Remove deprecated columns
ALTER TABLE entities
  DROP COLUMN IF EXISTS file_url,
  DROP COLUMN IF EXISTS file_path,
  DROP COLUMN IF EXISTS file_size,
  DROP COLUMN IF EXISTS file_type,
  DROP COLUMN IF EXISTS checksum;

-- Verify columns removed
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'entities' 
  AND column_name IN ('file_url', 'file_path', 'file_size', 'file_type', 'checksum');
-- Should return 0 rows
