-- Add skill_id to documents table so documents can be linked to their parent
-- skill (e.g., skill reference files like reference/02-scoring-framework.md).

ALTER TABLE documents ADD COLUMN IF NOT EXISTS skill_id UUID REFERENCES skills(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS documents_skill_id_idx ON documents(skill_id);
