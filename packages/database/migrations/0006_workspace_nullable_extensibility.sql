-- Allow pod-wide scope for extensibility/runtime configuration tables.
-- Guard each ALTER so migration remains compatible with older/provisioned schemas.
DO $$
BEGIN
  IF to_regclass('public.skill_triggers') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'skill_triggers'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE skill_triggers ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.intelligence_commands') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'intelligence_commands'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE intelligence_commands ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.mcp_servers') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'mcp_servers'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE mcp_servers ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.agent_configs') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'agent_configs'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE agent_configs ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;
