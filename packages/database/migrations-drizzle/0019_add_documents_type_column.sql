-- Migration: Add all missing columns to documents table
-- Description: Adds all columns that exist in Drizzle schema but missing in database
-- This migration is comprehensive and adds all required columns in one go
-- 
-- Note: This migration is idempotent - safe to run multiple times

DO $$
BEGIN
  -- Add type column (if not exists)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'type'
  ) THEN
    ALTER TABLE documents ADD COLUMN type TEXT NOT NULL DEFAULT 'text';
    CREATE INDEX IF NOT EXISTS documents_type_idx ON documents(type);
    -- Backfill existing documents
    UPDATE documents SET type = 'text' WHERE type IS NULL;
    ALTER TABLE documents ALTER COLUMN type DROP DEFAULT;
    RAISE NOTICE 'Added type column to documents table';
  END IF;

  -- Add language column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'language'
  ) THEN
    ALTER TABLE documents ADD COLUMN language TEXT;
    RAISE NOTICE 'Added language column to documents table';
  END IF;

  -- Add storage_url column (nullable - for whiteboards that don't need storage)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'storage_url'
  ) THEN
    ALTER TABLE documents ADD COLUMN storage_url TEXT;
    RAISE NOTICE 'Added storage_url column to documents table';
  END IF;

  -- Add storage_key column (nullable - for whiteboards that don't need storage)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'storage_key'
  ) THEN
    ALTER TABLE documents ADD COLUMN storage_key TEXT;
    RAISE NOTICE 'Added storage_key column to documents table';
  END IF;

  -- Add size column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'size'
  ) THEN
    ALTER TABLE documents ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
    RAISE NOTICE 'Added size column to documents table';
  END IF;

  -- Add mime_type column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'mime_type'
  ) THEN
    ALTER TABLE documents ADD COLUMN mime_type TEXT;
    RAISE NOTICE 'Added mime_type column to documents table';
  END IF;

  -- Add current_version column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'current_version'
  ) THEN
    ALTER TABLE documents ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;
    RAISE NOTICE 'Added current_version column to documents table';
  END IF;

  -- Add last_saved_version column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'last_saved_version'
  ) THEN
    ALTER TABLE documents ADD COLUMN last_saved_version INTEGER NOT NULL DEFAULT 0;
    RAISE NOTICE 'Added last_saved_version column to documents table';
  END IF;

  -- Add working_state column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'working_state'
  ) THEN
    ALTER TABLE documents ADD COLUMN working_state TEXT;
    RAISE NOTICE 'Added working_state column to documents table';
  END IF;

  -- Add working_state_updated_at column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'working_state_updated_at'
  ) THEN
    ALTER TABLE documents ADD COLUMN working_state_updated_at TIMESTAMP WITH TIME ZONE;
    RAISE NOTICE 'Added working_state_updated_at column to documents table';
  END IF;

  -- Add metadata column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE documents ADD COLUMN metadata JSONB;
    RAISE NOTICE 'Added metadata column to documents table';
  END IF;

  -- Add deleted_at column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE documents ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
    RAISE NOTICE 'Added deleted_at column to documents table';
  END IF;

  RAISE NOTICE 'Documents table migration complete - all columns added';
END $$;
