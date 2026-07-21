-- Migration: 0204_api_keys_instance_id.sql
--
-- Multi-instance agent keys (Track C) Wave 1 — the data layer.
--
-- Adds `api_keys.instance_id` (nullable text): a per-runtime label for concurrent
-- instances of the SAME agent identity (e.g. claude-code on two machines, or
-- CLI + MCP at once). The agent-user stays a pod-wide singleton per agentType —
-- an "instance" is a distinct KEY, not a distinct identity.
--
-- NULL = the legacy single-key model: minting an agent key revokes all the
-- agent-user's sibling hub_inbound keys, so only one instance can be live. When
-- instance_id is set, /setup/agent skips that blanket sibling-revoke and scopes
-- idempotency/rotation to the matching instance_id, so instances coexist.
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS instance_id text;
