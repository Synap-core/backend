-- Migration: Add 'type' column to documents table
-- Description: Adds the 'type' column that exists in Drizzle schema but missing in database
-- This enables proper type-safe document creation

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
