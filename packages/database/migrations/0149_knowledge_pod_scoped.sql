-- 0149: Make knowledge profile pod-scoped instead of workspace-scoped.
-- Knowledge (gotchas, lessons, decisions, references) is inherently
-- cross-cutting — a lesson learned in one workspace applies everywhere.
-- The ek_type discriminator already classifies the domain; keeping
-- entity_scope = 'workspace' only creates silos and forces duplication.
UPDATE profiles SET entity_scope = 'pod' WHERE slug = 'knowledge' AND entity_scope = 'workspace';
