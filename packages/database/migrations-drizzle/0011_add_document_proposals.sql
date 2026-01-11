-- Migration: Add document_proposals table
-- Created: 2026-01-08
-- Purpose: AI edit proposals and review workflow

CREATE TABLE IF NOT EXISTS document_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  
  -- Proposal metadata
  proposal_type TEXT NOT NULL, -- 'ai_edit' | 'user_suggestion' | 'review_comment' | 'offline_sync_conflict'
  proposed_by TEXT NOT NULL, -- 'ai' | user_id
  
  -- The actual changes (OT operations or JSON patch)
  changes JSONB NOT NULL,
  
  -- Content snapshots for diff display
  original_content TEXT,
  proposed_content TEXT,
  
  -- Status tracking
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected' | 'expired'
  
  -- Review metadata
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_comment TEXT,
  
  -- Auto-expire old proposals
  expires_at TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS document_proposals_document_id_idx ON document_proposals(document_id);
CREATE INDEX IF NOT EXISTS document_proposals_status_idx ON document_proposals(status);
CREATE INDEX IF NOT EXISTS document_proposals_expires_at_idx ON document_proposals(expires_at);

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_document_proposals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_proposals_updated_at
  BEFORE UPDATE ON document_proposals
  FOR EACH ROW
  EXECUTE FUNCTION update_document_proposals_updated_at();

-- Comments for documentation
COMMENT ON TABLE document_proposals IS 'Stores AI-suggested edits and user proposals awaiting review';
COMMENT ON COLUMN document_proposals.changes IS 'Array of OT operations: [{"op": "delete", "range": [0, 50]}, ...]';
COMMENT ON COLUMN document_proposals.expires_at IS 'Auto-expire proposals after 7 days (cleanup via cron)';
