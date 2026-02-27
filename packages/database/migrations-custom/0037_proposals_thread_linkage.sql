-- ============================================================
-- Migration 0037: Proposals — Thread, Message & Command Linkage
-- ============================================================
--
-- PROBLEM: Proposals had no provenance — we couldn't answer:
--   • Which chat thread spawned this proposal?
--   • Which message triggered it?
--   • Which command run generated it?
--   • Who created it? (was buried inside data JSONB)
--
-- DESIGN DECISIONS:
--   - All new columns are NULLABLE so existing proposals are unaffected.
--   - created_by is backfilled from data->>'sourceId' (JSONB).
--   - ON DELETE SET NULL for FKs: deleting a thread/run doesn't destroy
--     the proposal's record, it just loses the provenance link.
--   - source_message_id is the narrowest link (specific message in thread).
--     thread_id is denormalised here for fast "all proposals in thread" queries
--     without having to join through messages.
--   - command_run_id links to the command_runs.proposedActions audit trail.
--
-- SEPARATION OF CONCERNS:
--   • proposals.thread_id   → "which conversation produced this?"
--   • proposals.source_message_id → "which message specifically?"
--   • proposals.command_run_id → "which command execution run?"
--   • proposals.created_by  → "which user/agent account?"
--   (targetType + targetId remain for "what object is being changed?")
-- ============================================================

-- 1. Add provenance columns
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS created_by       TEXT,
  ADD COLUMN IF NOT EXISTS thread_id        UUID REFERENCES chat_threads(id)           ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS command_run_id   UUID REFERENCES command_runs(id)           ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_message_id UUID REFERENCES conversation_messages(id) ON DELETE SET NULL;

-- 2. Backfill created_by from the embedded JSONB data field
--    (data->>'sourceId' is how permission-check stored it previously)
UPDATE proposals
SET    created_by = data->>'sourceId'
WHERE  created_by IS NULL
  AND  data->>'sourceId' IS NOT NULL;

-- 3. Indexes for the new FK columns (partial — only where value exists)
CREATE INDEX IF NOT EXISTS idx_proposals_thread_id
  ON proposals(thread_id)
  WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proposals_command_run_id
  ON proposals(command_run_id)
  WHERE command_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proposals_source_message_id
  ON proposals(source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proposals_created_by
  ON proposals(created_by)
  WHERE created_by IS NOT NULL;

-- 4. Composite index for the common query: pending proposals for a thread
CREATE INDEX IF NOT EXISTS idx_proposals_thread_status
  ON proposals(thread_id, status)
  WHERE thread_id IS NOT NULL;
