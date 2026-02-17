-- Option B: symmetric document–entity link
-- documents.entity_id references entities.id; keep in sync when entity.document_id is set/cleared.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS entity_id UUID;

-- Add FK only if it does not exist (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_entity_id_fkey'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_entity_id_fkey
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS documents_entity_id_idx
  ON documents (entity_id) WHERE entity_id IS NOT NULL;
