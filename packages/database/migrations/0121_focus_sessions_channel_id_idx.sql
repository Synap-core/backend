-- One active focus session per channel + query index for channels.ts per-message lookup.
-- Partial unique index enforces the one-active-per-channel invariant structurally and
-- doubles as the covering index for WHERE channel_id = ? AND status = 'active' queries.
-- NULL channel_id is excluded so CLI/API sessions without a channel remain unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_sessions_active_channel
  ON focus_sessions (channel_id)
  WHERE status = 'active' AND channel_id IS NOT NULL;
