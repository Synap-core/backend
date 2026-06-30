-- First-class Playbook stages (ADDITIVE).
-- playbooks.stages       — PlaybookStage[] (ordered phases). Empty [] = progress-only (today's behavior).
-- focus_sessions.current_stage — the active stage key. NULL for stageless playbooks; never NOT NULL.
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS stages jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE focus_sessions ADD COLUMN IF NOT EXISTS current_stage text;
