-- 0172_remove_hermes_agent.sql
--
-- Retire the Hermes system agent seeded by 0031_hermes_agent.sql.
--
-- The Hermes runtime is being fully decommissioned. This migration DEACTIVATES
-- the seeded `agents` row (owner_type='system', pod-native) rather than deleting
-- it, so it disappears from every agent picker / agentHandle resolution path
-- (all of which filter on `active = true`) WITHOUT orphaning any FK reference.
--
-- FK safety: `channels.assigned_agent_id` and `channels.sender_agent_id` both
-- reference `agents(id)` with ON DELETE SET NULL. A hard DELETE would therefore
-- succeed but NULL out those columns on any channel that had Hermes assigned or
-- as its last sender — silently destroying message-attribution history. Since we
-- cannot prove zero references at migration time and deactivation fully achieves
-- removal-from-pickers, deactivation is the safe, non-destructive choice.
--
-- Pure DML (no schema change) → no 0000_baseline_schema.sql / schema-coherence
-- update needed. Idempotent via the WHERE guard (safe to re-run).

UPDATE agents
SET active = false,
    updated_at = now()
WHERE agent_slug = 'hermes'
  AND owner_type = 'system'
  AND intelligence_service_id IS NULL
  AND active = true;
