-- Pod-to-Pod Sync Tables
-- Created: 2026-03-28
-- Purpose: Event log replication between primary and fallback pods

-- ─── sync_peers: registered sync targets ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS sync_peers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  peer_pod_url TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('push', 'pull', 'bidirectional')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  label TEXT,
  auth_token TEXT,
  workspace_ids TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_peers_enabled ON sync_peers (enabled, direction);

-- ─── sync_state: cursor tracking per peer ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS sync_state (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sync_peer_id UUID NOT NULL REFERENCES sync_peers(id) ON DELETE CASCADE,
  last_cursor TIMESTAMPTZ,
  last_push_cursor TIMESTAMPTZ,
  last_pull_cursor TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'syncing', 'error')),
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  events_processed INTEGER NOT NULL DEFAULT 0,
  supplementary_cursors JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_state_peer ON sync_state (sync_peer_id);

-- ─── sync_conflicts: audit log for LWW conflict resolution ───────────────────

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sync_peer_id UUID REFERENCES sync_peers(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  local_timestamp TIMESTAMPTZ,
  remote_timestamp TIMESTAMPTZ,
  resolution TEXT NOT NULL CHECK (resolution IN ('local_wins', 'remote_wins')),
  event_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_peer ON sync_conflicts (sync_peer_id, created_at);
