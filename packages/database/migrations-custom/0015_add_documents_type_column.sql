-- Migration: Add 'type' column to documents table
-- Description: Adds the 'type' column that exists in Drizzle schema but missing in database
-- This enables proper type-safe document creation
-- 
-- Also makes storageUrl and storageKey nullable for whiteboards (they don't need file storage)

-- Add type column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' AND column_name = 'type'
  ) THEN
    ALTER TABLE documents 
    ADD COLUMN type TEXT NOT NULL DEFAULT 'text';
    
    -- Create index for type column (as defined in Drizzle schema)
    CREATE INDEX IF NOT EXISTS documents_type_idx ON documents(type);
    
    -- Update existing documents: infer type from metadata or default to 'text'
    UPDATE documents 
    SET type = COALESCE(
      (metadata->>'type')::text,
      CASE 
        WHEN storage_key LIKE '%.md' OR storage_key LIKE '%markdown%' THEN 'markdown'
        WHEN storage_key LIKE '%.pdf' THEN 'pdf'
        WHEN storage_key LIKE '%.docx' THEN 'docx'
        WHEN storage_key LIKE '%code%' OR storage_key LIKE '%.ts' OR storage_key LIKE '%.js' THEN 'code'
        WHEN storage_key LIKE '%whiteboard%' THEN 'whiteboard'
        ELSE 'text'
      END,
      'text'
    )
    WHERE type IS NULL OR type = 'text';
    
    -- Remove default after backfilling (column should be NOT NULL)
    ALTER TABLE documents ALTER COLUMN type DROP DEFAULT;
    
    RAISE NOTICE 'Added type column to documents table';
  ELSE
    RAISE NOTICE 'Type column already exists in documents table';
  END IF;
END $$;

-- Make storageUrl and storageKey nullable for whiteboards (they store content in document_versions, not external storage)
DO $$
BEGIN
  -- Check if columns are currently NOT NULL
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' 
    AND column_name = 'storage_url' 
    AND is_nullable = 'NO'
  ) THEN
    -- Make storageUrl nullable
    ALTER TABLE documents ALTER COLUMN storage_url DROP NOT NULL;
    RAISE NOTICE 'Made storage_url nullable';
  END IF;
  
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'documents' 
    AND column_name = 'storage_key' 
    AND is_nullable = 'NO'
  ) THEN
    -- Make storageKey nullable
    ALTER TABLE documents ALTER COLUMN storage_key DROP NOT NULL;
    RAISE NOTICE 'Made storage_key nullable';
  END IF;
  
  -- Set NULL for existing whiteboard documents (they don't need storage)
  UPDATE documents 
  SET storage_url = NULL, storage_key = NULL
  WHERE type = 'whiteboard' AND (storage_url LIKE 'internal://%' OR storage_key LIKE 'whiteboards/%');
  
  RAISE NOTICE 'Updated whiteboard documents to have NULL storage fields';
END $$;
