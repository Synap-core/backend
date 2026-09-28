-- Migration: 0280_api_keys_tool_profile.sql
--
-- MCP tool profiles (V1 D4, gap G10). An agent key carries the tool surface its
-- MCP client LISTS:
--
--   tool_profile  NULL      = legacy — every tool (every key minted before this
--                             migration keeps exactly what it had; D4 changes
--                             nothing for existing keys).
--                 'entry'   = the 9-tool entry surface (new agent keys).
--                 'builder' = every tool, chosen deliberately.
--   tool_groups   the deeper tool groups an entry key has unlocked through
--                 `synap_load_skill` — sticky per key (the /mcp transport is
--                 stateless, so the key is the one per-client fact that lasts).
--
-- A profile narrows LISTING only; it is not a permission. Scopes and governance
-- stay the authority on what a key may do.
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tool_profile text;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tool_groups text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_tool_profile_check'
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_tool_profile_check
      CHECK (tool_profile IS NULL OR tool_profile IN ('entry', 'builder'));
  END IF;
END $$;
