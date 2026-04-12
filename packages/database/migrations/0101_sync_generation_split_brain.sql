-- ============================================================================
-- 0101_sync_generation_split_brain.sql
-- ============================================================================
--
-- Split-brain prevention for dual-pod redundancy.
--
-- Adds a sync_generation table to track write epochs per pod. During sync,
-- pods exchange their current generation. If both generations advance during
-- a network partition, split-brain is detected and the pod with fewer writes
-- is demoted to read-only mode.
--
-- See docs-internal/SPLIT-BRAIN-PREVENTION.md for full design.
-- ============================================================================

-- ─── sync_generation: write epoch tracking ──────────────────────────────────

CREATE TABLE IF NOT EXISTS sync_generation (
  id TEXT PRIMARY KEY DEFAULT 'current',
  generation BIGINT NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'primary'
    CHECK (role IN ('primary', 'replica', 'standalone', 'readonly')),
  promoted_at TIMESTAMPTZ,
  promoted_from TEXT,
  last_peer_generation BIGINT DEFAULT 0,
  last_peer_contact TIMESTAMPTZ,
  split_brain_detected BOOLEAN NOT NULL DEFAULT false,
  split_brain_detected_at TIMESTAMPTZ,
  split_brain_local_gen BIGINT,
  split_brain_remote_gen BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the default row if it doesn't exist
INSERT INTO sync_generation (id, generation, role)
VALUES ('current', 0, 'primary')
ON CONFLICT (id) DO NOTHING;
