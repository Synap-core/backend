ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS subject_entity_id uuid;

CREATE INDEX IF NOT EXISTS automation_runs_subject_entity_id_idx
  ON automation_runs (subject_entity_id);
