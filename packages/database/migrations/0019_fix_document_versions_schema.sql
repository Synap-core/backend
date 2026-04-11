-- Migration: Fix document_versions table schema
-- Description: Adds missing columns to match Drizzle schema definition
-- The initial migration created a basic table, but the schema evolved to include versioning, author tracking, etc.

DO $$
BEGIN
  -- Add version column (if not exists)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'document_versions' AND column_name = 'version'
  ) THEN
    ALTER TABLE document_versions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    RAISE NOTICE 'Added version column to document_versions table';
  END IF;

  -- Note: 'type' and 'delta' columns were removed from schema as they were never used
  -- If they exist in the database, we'll drop them (they're not needed)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'document_versions' AND column_name = 'type'
  ) THEN
    ALTER TABLE document_versions DROP COLUMN type;
    RAISE NOTICE 'Removed unused type column from document_versions table';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'document_versions' AND column_name = 'delta'
  ) THEN
    ALTER TABLE document_versions DROP COLUMN delta;
    RAISE NOTICE 'Removed unused delta column from document_versions table';
  END IF;

  -- Rename created_by to author (if created_by exists and author doesn't)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'document_versions' AND column_name = 'created_by'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'document_versions' AND column_name = 'author'
  ) THEN
    ALTER TABLE document_versions RENAME COLUMN created_by TO author;
    RAISE NOTICE 'Renamed created_by to author in document_versions table';
  END IF;

  -- Add author column if it doesn't exist (and created_by was already renamed or never existed)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'document_versions' AND column_name = 'author'
  ) THEN
    ALTER TABLE document_versions ADD COLUMN author TEXT NOT NULL DEFAULT 'user';
    -- Backfill existing rows if any
    UPDATE document_versions SET author = 'user' WHERE author IS NULL;
    ALTER TABLE document_versions ALTER COLUMN author DROP DEFAULT;
    RAISE NOTICE 'Added author column to document_versions table';
  END IF;

  -- Add author_id column (if not exists)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'document_versions' AND column_name = 'author_id'
  ) THEN
    ALTER TABLE document_versions ADD COLUMN author_id TEXT NOT NULL DEFAULT '';
    -- Backfill existing rows if any (we can't infer author_id from old data, so use empty string)
    -- This is acceptable since old versions won't have proper author tracking
    UPDATE document_versions SET author_id = '' WHERE author_id IS NULL;
    ALTER TABLE document_versions ALTER COLUMN author_id DROP DEFAULT;
    RAISE NOTICE 'Added author_id column to document_versions table';
  END IF;

  -- Add message column (if not exists)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'document_versions' AND column_name = 'message'
  ) THEN
    ALTER TABLE document_versions ADD COLUMN message TEXT;
    RAISE NOTICE 'Added message column to document_versions table';
  END IF;

  -- Convert content from jsonb to text (if it's currently jsonb)
  -- This is a data migration - we'll convert jsonb to text representation
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'document_versions' 
    AND column_name = 'content' 
    AND data_type = 'jsonb'
  ) THEN
    -- Create new text column
    ALTER TABLE document_versions ADD COLUMN content_text TEXT;
    
    -- Migrate data: convert jsonb to text (JSON string representation)
    UPDATE document_versions 
    SET content_text = content::text
    WHERE content IS NOT NULL;
    
    -- Drop old jsonb column
    ALTER TABLE document_versions DROP COLUMN content;
    
    -- Rename new column to content
    ALTER TABLE document_versions RENAME COLUMN content_text TO content;
    
    -- Make it NOT NULL (after migration)
    ALTER TABLE document_versions ALTER COLUMN content SET NOT NULL;
    
    RAISE NOTICE 'Converted content column from jsonb to text in document_versions table';
  END IF;

  -- Remove description column if it exists (not in Drizzle schema)
  -- Commented out - keep it for now in case it's used elsewhere
  -- IF EXISTS (
  --   SELECT 1 FROM information_schema.columns 
  --   WHERE table_name = 'document_versions' AND column_name = 'description'
  -- ) THEN
  --   ALTER TABLE document_versions DROP COLUMN description;
  --   RAISE NOTICE 'Removed description column from document_versions table';
  -- END IF;

  -- Create indexes if they don't exist
  CREATE INDEX IF NOT EXISTS document_versions_document_id_idx ON document_versions(document_id);
  CREATE INDEX IF NOT EXISTS document_versions_version_idx ON document_versions(document_id, version);

  RAISE NOTICE 'Document versions table migration complete - all columns added';
END $$;
