/**
 * Migration: Add document references and metadata to entities
 * 
 * Changes:
 * 1. Add metadata JSONB column
 * 2. Add document_id column (foreign key to documents)
 * 3. Remove file storage columns (to be handled by documents table)
 * 
 * Migration strategy:
 * - Phase 1: Add new columns
 * - Phase 2: Migrate existing data (if any)
 * - Phase 3: Remove old file columns
 */

-- Phase 1: Add new columns
ALTER TABLE entities 
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

-- Create index on metadata for faster JSONB queries
CREATE INDEX IF NOT EXISTS idx_entities_metadata ON entities USING GIN (metadata);

-- Create index on document_id for joins
CREATE INDEX IF NOT EXISTS idx_entities_document_id ON entities (document_id);

-- Phase 2: Migrate existing task_details data to metadata
UPDATE entities e
SET metadata = jsonb_build_object(
  'status', COALESCE(td.status, 'todo'),
  'priority', CASE 
    WHEN td.priority = 0 THEN NULL
    WHEN td.priority = 1 THEN 'low'
    WHEN td.priority = 2 THEN 'medium'
    WHEN td.priority = 3 THEN 'high'
    WHEN td.priority = 4 THEN 'urgent'
    ELSE NULL
  END,
  'dueDate', CASE 
    WHEN td.due_date IS NOT NULL THEN to_char(td.due_date, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ELSE NULL
  END,
  'completedAt', CASE 
    WHEN td.completed_at IS NOT NULL THEN to_char(td.completed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ELSE NULL
  END
)
FROM task_details td
WHERE e.id = td.entity_id AND e.type = 'task';

-- Phase 3: Remove old file storage columns
-- (commented out for safety - run manually after verifying data migration)
-- ALTER TABLE entities
--   DROP COLUMN IF EXISTS file_url,
--   DROP COLUMN IF EXISTS file_path,
--   DROP COLUMN IF EXISTS file_size,
--   DROP COLUMN IF EXISTS file_type,
--   DROP COLUMN IF EXISTS checksum;

-- Optional: Drop task_details table after migration
-- (commented out for safety - verify all data migrated first)
-- DROP TABLE IF EXISTS task_details;
