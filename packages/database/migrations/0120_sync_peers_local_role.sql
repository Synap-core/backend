-- ─── 0120: sync_peers.local_role — local-twin role for split-brain handling ──
--
-- Adds a `local_role` column to `sync_peers` that controls how split-brain
-- detection behaves for this peer relationship:
--
--   "primary"   → authority pod; current split-brain behavior (lower-gen demoted).
--   "secondary" → offline-capable local twin; NEVER auto-demoted to readonly.
--                 On divergence it logs loudly and continues, relying on LWW.
--   "unset"     → no role configured; legacy/default behavior preserved.
--
-- Default "unset" is backward-compatible: existing peers keep current behavior.

ALTER TABLE "sync_peers" ADD COLUMN IF NOT EXISTS "local_role" text DEFAULT 'unset';
