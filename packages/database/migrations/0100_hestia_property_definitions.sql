-- Migration: Add Hestia OS System Profiles
-- Creates property definitions for hearth_node, intelligence_provider, package_instance, hearth_deployment
-- These are used by the hestia-os.json workspace template

-- Property definitions for Hestia profiles
INSERT INTO property_defs (id, slug, profile_id, workspace_id, value_type, constraints, ui_hints, created_at, updated_at)
VALUES 
  -- hearth_node properties
  (gen_random_uuid(), 'hostname', NULL, NULL, 'string', '{"indexed": true, "required": true}', '{"label": "Hostname", "inputType": "text"}', NOW(), NOW()),
  (gen_random_uuid(), 'ip_address', NULL, NULL, 'string', '{}', '{"label": "IP Address", "inputType": "text"}', NOW(), NOW()),
  (gen_random_uuid(), 'role', NULL, NULL, 'string', '{"enum": ["primary", "backup"], "default": "primary"}', '{"label": "Role", "inputType": "select"}', NOW(), NOW()),
  (gen_random_uuid(), 'install_mode', NULL, NULL, 'string', '{"enum": ["usb", "script"]}', '{"label": "Install Mode", "inputType": "select"}', NOW(), NOW()),
  (gen_random_uuid(), 'health_status', NULL, NULL, 'string', '{"enum": ["healthy", "degraded", "offline"], "default": "unknown", "indexed": true}', '{"label": "Health Status", "inputType": "select"}', NOW(), NOW()),
  (gen_random_uuid(), 'last_heartbeat', NULL, NULL, 'date', '{}', '{"label": "Last Heartbeat", "inputType": "datetime"}', NOW(), NOW()),
  
  -- intelligence_provider properties
  (gen_random_uuid(), 'provider_type', NULL, NULL, 'string', '{"enum": ["ollama", "openrouter", "anthropic", "openai", "custom"], "required": true}', '{"label": "Provider Type", "inputType": "select"}', NOW(), NOW()),
  (gen_random_uuid(), 'endpoint_url', NULL, NULL, 'string', '{}', '{"label": "Endpoint URL", "inputType": "text"}', NOW(), NOW()),
  (gen_random_uuid(), 'api_key_env', NULL, NULL, 'string', '{"secret": true}', '{"label": "API Key Env Var", "inputType": "text"}', NOW(), NOW()),
  (gen_random_uuid(), 'capabilities', NULL, NULL, 'array', '{}', '{"label": "Capabilities", "inputType": "tags"}', NOW(), NOW()),
  
  -- package_instance properties
  (gen_random_uuid(), 'package_name', NULL, NULL, 'string', '{"indexed": true, "required": true}', '{"label": "Package Name", "inputType": "text"}', NOW(), NOW()),
  (gen_random_uuid(), 'version', NULL, NULL, 'string', '{"required": true}', '{"label": "Version", "inputType": "text"}', NOW(), NOW()),
  (gen_random_uuid(), 'status', NULL, NULL, 'string', '{"enum": ["installed", "running", "stopped", "error", "updating"], "default": "installed"}', '{"label": "Status", "inputType": "select"}', NOW(), NOW()),
  (gen_random_uuid(), 'installed_at', NULL, NULL, 'date', '{}', '{"label": "Installed At", "inputType": "datetime"}', NOW(), NOW()),
  (gen_random_uuid(), 'last_updated', NULL, NULL, 'date', '{}', '{"label": "Last Updated", "inputType": "datetime"}', NOW(), NOW()),
  
  -- hearth_deployment properties
  (gen_random_uuid(), 'deploy_path', NULL, NULL, 'string', '{"required": true}', '{"label": "Deploy Path", "inputType": "text"}', NOW(), NOW()),
  (gen_random_uuid(), 'artifact_type', NULL, NULL, 'string', '{"enum": ["static", "containerized"], "required": true}', '{"label": "Artifact Type", "inputType": "select"}', NOW(), NOW()),
  (gen_random_uuid(), 'source_type', NULL, NULL, 'string', '{"enum": ["git", "workspace", "upload"]}', '{"label": "Source Type", "inputType": "select"}', NOW(), NOW()),
  (gen_random_uuid(), 'source_url', NULL, NULL, 'string', '{}', '{"label": "Source URL", "inputType": "text"}', NOW(), NOW()),
  (gen_random_uuid(), 'url', NULL, NULL, 'string', '{}', '{"label": "Deployed URL", "inputType": "url"}', NOW(), NOW()),
  (gen_random_uuid(), 'build_log', NULL, NULL, 'text', '{}', '{"label": "Build Log", "inputType": "textarea"}', NOW(), NOW()),
  (gen_random_uuid(), 'commands_executed', NULL, NULL, 'array', '{}', '{"label": "Commands Executed", "inputType": "json"}', NOW(), NOW()),
  (gen_random_uuid(), 'approvals', NULL, NULL, 'array', '{}', '{"label": "Approvals", "inputType": "json"}', NOW(), NOW()),
  (gen_random_uuid(), 'started_at', NULL, NULL, 'date', '{}', '{"label": "Started At", "inputType": "datetime"}', NOW(), NOW()),
  (gen_random_uuid(), 'completed_at', NULL, NULL, 'date', '{}', '{"label": "Completed At", "inputType": "datetime"}', NOW(), NOW())
ON CONFLICT (slug, COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'), COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000')) 
DO NOTHING;

-- Create system profiles for Hestia (these will be created by ensureSystemProfiles or hestia-os.json template)
-- Note: The actual profile creation happens via the workspace template system
-- This migration just ensures the property definitions exist

-- Add comment for future reference
COMMENT ON TABLE property_defs IS 'Extended with Hestia properties (migration 0100): hostname, ip_address, role, install_mode, health_status, last_heartbeat, provider_type, endpoint_url, api_key_env, capabilities, package_name, version, status, installed_at, last_updated, deploy_path, artifact_type, source_type, source_url, url, build_log, commands_executed, approvals, started_at, completed_at';
