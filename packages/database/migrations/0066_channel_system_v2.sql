-- Migration: Channel System V2
-- Simplifies 9 channel types → 6, removes channelPurpose, adds scope + feedScope.
-- See docs/CHANNEL-SYSTEM.md for the full design spec.
--
-- Defensive: every operation is wrapped in an IF EXISTS check on the channels table.
-- On fresh pods the channels table is created by custom/0038_channels_refactor.sql,
-- which (with the interleaved runner) sorts after this file for some suffixes.
-- Any pod that reaches this migration before channels exists will skip it cleanly;
-- 0099_schema_reconciliation.sql (custom, runs last) catches up those pods.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'channels'
  ) THEN
    RAISE NOTICE '0066_channel_system_v2: channels table does not exist yet — skipping. Will be caught up by 0099_schema_reconciliation.';
    RETURN;
  END IF;

  -- ─── Add new columns with safe defaults ──────────────────────────────────

  ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'workspace'
      CHECK (scope IN ('pod', 'workspace', 'user'));

  ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS feed_scope TEXT
      CHECK (feed_scope IN ('user', 'workspace'));

  -- ─── Rename agentType: 'default' → 'none' ────────────────────────────────

  UPDATE channels SET agent_type = 'none' WHERE agent_type = 'default';

  -- ─── Migrate channelPurpose=chat channels → type=personal, scope=pod ─────
  -- Must run BEFORE the ai_thread catch-all below.

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'channel_purpose'
  ) THEN
    UPDATE channels
      SET channel_type = 'personal',
          scope = 'pod'
      WHERE channel_purpose = 'chat';

    -- ─── Migrate channelPurpose=feed channels → type=feed, scope=pod, feed_scope=user ──

    UPDATE channels
      SET channel_type = 'feed',
          scope = 'pod',
          feed_scope = 'user'
      WHERE channel_purpose = 'feed';

    -- ─── Archive audit channels (event log is source of truth) ───────────────

    UPDATE channels
      SET status = 'archived'
      WHERE channel_purpose = 'audit';
  END IF;

  -- ─── Rename remaining type values ────────────────────────────────────────

  -- Remaining ai_threads (no channelPurpose) → thread (workspace-scoped)
  UPDATE channels
    SET channel_type = 'thread',
        scope = 'workspace'
    WHERE channel_type = 'ai_thread';

  UPDATE channels
    SET channel_type = 'sub_thread'
    WHERE channel_type = 'branch';

  UPDATE channels
    SET channel_type = 'thread'
    WHERE channel_type IN ('entity_comments', 'document_review', 'view_discussion');

  UPDATE channels
    SET channel_type = 'external'
    WHERE channel_type = 'external_import';

  UPDATE channels
    SET channel_type = 'agent_collab'
    WHERE channel_type = 'a2ai';

  -- thread type (old user-created sub-conversations) → sub_thread
  -- These are channels of type 'thread' that have a parentChannelId.
  UPDATE channels
    SET channel_type = 'sub_thread'
    WHERE channel_type = 'thread'
      AND parent_channel_id IS NOT NULL;

  -- ─── Set scope for channels where it wasn't already set ──────────────────

  -- Channels without a workspace (pod-wide) should be pod scope
  UPDATE channels
    SET scope = 'pod'
    WHERE workspace_id IS NULL AND scope = 'workspace';

  -- ─── Populate contextObjectType defaults ─────────────────────────────────

  -- Threads that have no contextObjectType should default to workspace
  UPDATE channels
    SET context_object_type = 'workspace',
        context_object_id = workspace_id
    WHERE channel_type = 'thread'
      AND context_object_type IS NULL
      AND workspace_id IS NOT NULL;

  -- ─── Drop old columns ─────────────────────────────────────────────────────

  -- Drop purposeIdx first (index on channel_purpose)
  DROP INDEX IF EXISTS channels_purpose_idx;

  -- Drop channel_purpose column
  ALTER TABLE channels DROP COLUMN IF EXISTS channel_purpose;

  -- ─── Add new indexes ──────────────────────────────────────────────────────

  CREATE INDEX IF NOT EXISTS channels_scope_idx ON channels (scope);
  CREATE INDEX IF NOT EXISTS channels_type_idx ON channels (channel_type);

END;
$$;
