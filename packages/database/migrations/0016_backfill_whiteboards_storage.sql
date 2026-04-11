-- Migration: Backfill whiteboards with MinIO storage
-- Description: Migrates existing whiteboards to use MinIO storage (unified storage approach)
--              This ensures all documents use the same storage pattern

DO $$
DECLARE
  whiteboard_record RECORD;
  storage_key TEXT;
  storage_url TEXT;
  content_text TEXT;
  latest_version RECORD;
BEGIN
  -- Find all whiteboard documents without storage
  FOR whiteboard_record IN
    SELECT d.id, d.user_id, d.workspace_id, d.title
    FROM documents d
    WHERE d.type = 'whiteboard'
      AND (d.storage_key IS NULL OR d.storage_key = '')
  LOOP
    -- Get latest version content (whiteboards stored content in document_versions)
    SELECT INTO latest_version
      content, version
    FROM document_versions
    WHERE document_id = whiteboard_record.id
    ORDER BY version DESC
    LIMIT 1;

    IF latest_version IS NOT NULL THEN
      -- Build storage key (same pattern as new whiteboards)
      storage_key := 'whiteboards/' || whiteboard_record.workspace_id || '/' || whiteboard_record.id || '.json';
      
      -- For now, we'll set a placeholder URL
      -- In production, you'd actually upload to MinIO and get the real URL
      -- This migration assumes you'll run a separate script to upload content to MinIO
      storage_url := 'minio://' || storage_key;

      -- Update document with storage info
      UPDATE documents
      SET 
        storage_key = storage_key,
        storage_url = storage_url,
        size = LENGTH(latest_version.content),
        mime_type = 'application/json',
        updated_at = NOW()
      WHERE id = whiteboard_record.id;

      RAISE NOTICE 'Backfilled whiteboard % with storage key: %', whiteboard_record.id, storage_key;
    ELSE
      RAISE WARNING 'Whiteboard % has no versions, skipping', whiteboard_record.id;
    END IF;
  END LOOP;

  RAISE NOTICE 'Whiteboard storage backfill completed';
END $$;

-- Note: After running this migration, you should run a script to actually upload
-- the content from document_versions to MinIO storage for each whiteboard.
-- The storage_key is set, but the actual file needs to be uploaded to MinIO.
