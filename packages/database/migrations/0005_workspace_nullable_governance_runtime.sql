-- Allow pod-wide scope for governance/runtime tables.
-- Guard each ALTER so migration remains compatible with older/provisioned schemas.
DO $$
BEGIN
  IF to_regclass('public.proposals') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'proposals'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE proposals ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.notifications') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'notifications'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE notifications ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.notification_preferences') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'notification_preferences'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE notification_preferences ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.automations') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'automations'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE automations ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.automation_runs') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'automation_runs'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE automation_runs ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.channel_context_items') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'channel_context_items'
         AND column_name = 'workspace_id'
     ) THEN
    EXECUTE 'ALTER TABLE channel_context_items ALTER COLUMN workspace_id DROP NOT NULL';
  END IF;
END $$;
