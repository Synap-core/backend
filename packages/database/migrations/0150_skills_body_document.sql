-- Storage unification: skills.body becomes a denormalized cache. The canonical
-- storage is a MinIO-backed document (versioned, collaborative). body_document_id
-- links to it; body stays as the hot-path cache the IS loader reads.

ALTER TABLE skills ADD COLUMN IF NOT EXISTS body_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS skills_body_document_id_idx ON skills(body_document_id);
