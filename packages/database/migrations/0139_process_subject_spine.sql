-- ── Process North Star — Subject Spine (Wave 0 schema) ───────────────────────
--
-- Additive only. No drops, no data migration, no FK constraints.
--
-- focus_sessions: subject_entity_id — the entity this session "is about"
-- playbooks:      flow_automation_id — the automation that drives this playbook
-- playbooks:      subject_profile    — { profileSlug, filter } subject selector

ALTER TABLE focus_sessions ADD COLUMN IF NOT EXISTS subject_entity_id uuid;
CREATE INDEX IF NOT EXISTS idx_focus_sessions_subject_entity_id ON focus_sessions (subject_entity_id);

ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS flow_automation_id uuid;
CREATE INDEX IF NOT EXISTS idx_playbooks_flow_automation_id ON playbooks (flow_automation_id);

ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS subject_profile jsonb;
