-- Relax workspace requirement for pod-wide resources.
-- Guard each ALTER so migration remains compatible with older/provisioned schemas.
DO $$
BEGIN
  IF to_regclass('public.relations') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'relations'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE relations ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.projects') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'projects'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE projects ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.inbox_items') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'inbox_items'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE inbox_items ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.message_links') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'message_links'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE message_links ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.command_runs') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'command_runs'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE command_runs ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;
