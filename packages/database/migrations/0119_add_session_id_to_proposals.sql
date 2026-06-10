-- 0119_add_session_id_to_proposals.sql
-- Add session_id FK to proposals table for linking proposals to focus sessions.
-- This replaces the fragile correlationId text-match linking with a proper FK.

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES focus_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_proposals_session_id ON proposals(session_id);
