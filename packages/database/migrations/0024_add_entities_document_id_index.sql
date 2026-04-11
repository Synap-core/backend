-- Index for reverse lookup: document -> entity
-- Enables efficient entities.getByDocumentId queries
CREATE INDEX IF NOT EXISTS entities_document_id_idx ON entities (document_id) WHERE document_id IS NOT NULL;
