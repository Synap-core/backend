-- Allow pod-wide scope for extensibility/runtime configuration tables.
ALTER TABLE skill_triggers
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE intelligence_commands
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE mcp_servers
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE agent_configs
ALTER COLUMN workspace_id DROP NOT NULL;
