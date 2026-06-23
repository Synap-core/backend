-- Revert the inverted relationship: documents.skill_id (document knows about skill)
-- is architecturally wrong. Documents are generic substrate; the skill stores the
-- documents it references (document_ids TEXT[]). A document can be linked by
-- multiple skills, entities, or channels without knowing about any of them.

ALTER TABLE documents DROP COLUMN IF EXISTS skill_id;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS document_ids TEXT[] DEFAULT '{}';
