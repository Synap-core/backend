-- 0146_tool_auth_binding.sql
--
-- Dynamic tool authentication binding. A Tool's credential can now resolve per
-- principal at execution time instead of always using one shared credential:
--   static     — the tool's own credential_ref (DEFAULT, unchanged behaviour)
--   per_user   — the acting user's credential
--   per_agent  — the acting agent-user's credential
--   per_entity — the run's subject entity's credential (e.g. per client)
--
-- The dynamic bindings resolve via a `provides_credential` edge in the existing
-- `links` table (principal|entity --provides_credential--> secret, with
-- metadata.toolId). `links` columns are free-text, so only `tools` needs DDL.
-- Existing rows default to 'static' → byte-identical behaviour.

ALTER TABLE tools
  ADD COLUMN IF NOT EXISTS auth_binding text NOT NULL DEFAULT 'static';
