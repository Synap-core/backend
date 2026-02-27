-- ============================================================
-- Migration 0038: Channels Refactor
-- ============================================================
--
-- CHANGES:
--   1. chat_threads        → channels  (richer channel_type, new context columns)
--   2. conversation_messages → messages (author_type, message_category, external_source, inbox_item_id)
--   3. document_sessions.chat_thread_id → channel_id
--   4. thread_entities + thread_documents → channel_context_items (unified polymorphic)
--
-- DESIGN:
--   - channel_type='ai_thread' replaces old threadType='main'
--   - 'branch' stays as-is
--   - New channel types (entity_comments, document_review, view_discussion, direct,
--     external_import) are first-class, not JSONB hacks
--   - messages.author_type + message_category replace role-guessing
--   - channel_context_items uses (objectType, objectId) polymorphism so any
--     entity, document, view, proposal, or inbox_item can be tracked
--   - ON DELETE CASCADE from channels preserved throughout
-- ============================================================

-- ============================================================
-- Step 1: Rename chat_threads → channels
-- ============================================================

ALTER TABLE chat_threads RENAME TO channels;
ALTER TABLE channels RENAME COLUMN thread_type TO channel_type;
ALTER TABLE channels RENAME COLUMN parent_thread_id TO parent_channel_id;

-- Migrate old threadType values: 'main' → 'ai_thread'; 'branch' stays
UPDATE channels SET channel_type = 'ai_thread' WHERE channel_type = 'main';

-- Add new columns (all nullable — no impact on existing rows)
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS context_object_type  TEXT,
  ADD COLUMN IF NOT EXISTS context_object_id    UUID,
  ADD COLUMN IF NOT EXISTS external_source      TEXT,
  ADD COLUMN IF NOT EXISTS external_channel_id  TEXT;

-- Rename indexes (may not exist in all environments — use IF EXISTS)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'chat_threads_user_id_idx') THEN
    ALTER INDEX chat_threads_user_id_idx RENAME TO channels_user_id_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'chat_threads_workspace_id_idx') THEN
    ALTER INDEX chat_threads_workspace_id_idx RENAME TO channels_workspace_id_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'chat_threads_parent_thread_id_idx') THEN
    ALTER INDEX chat_threads_parent_thread_id_idx RENAME TO channels_parent_channel_id_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'chat_threads_status_idx') THEN
    ALTER INDEX chat_threads_status_idx RENAME TO channels_status_idx;
  END IF;
END $$;

-- New index for context lookups (entity/document comment channels)
CREATE INDEX IF NOT EXISTS channels_context_idx
  ON channels(context_object_type, context_object_id)
  WHERE context_object_id IS NOT NULL;


-- ============================================================
-- Step 2: Rename conversation_messages → messages
-- ============================================================

ALTER TABLE conversation_messages RENAME TO messages;
ALTER TABLE messages RENAME COLUMN thread_id TO channel_id;

-- Add new classification columns (all have safe defaults)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS author_type      TEXT NOT NULL DEFAULT 'human',
  ADD COLUMN IF NOT EXISTS message_category TEXT NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS external_source  TEXT,
  ADD COLUMN IF NOT EXISTS inbox_item_id    UUID REFERENCES inbox_items(id) ON DELETE SET NULL;

-- Backfill author_type from role
UPDATE messages SET author_type = 'ai_agent' WHERE role = 'assistant';
UPDATE messages SET author_type = 'bot'      WHERE role = 'system';
-- role='user' stays as author_type='human' (default already applied)

-- Add indexes for new columns
CREATE INDEX IF NOT EXISTS messages_channel_id_idx
  ON messages(channel_id);
CREATE INDEX IF NOT EXISTS messages_inbox_item_idx
  ON messages(inbox_item_id)
  WHERE inbox_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_ext_source_idx
  ON messages(external_source)
  WHERE external_source IS NOT NULL;


-- ============================================================
-- Step 3: Rename document_sessions.chat_thread_id → channel_id
-- ============================================================

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_sessions' AND column_name = 'chat_thread_id'
  ) THEN
    ALTER TABLE document_sessions RENAME COLUMN chat_thread_id TO channel_id;
  END IF;
END $$;


-- ============================================================
-- Step 4: Create channel_context_items (unified)
-- ============================================================

CREATE TABLE IF NOT EXISTS channel_context_items (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_id        UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  object_type       TEXT        NOT NULL,
  -- ^ 'entity' | 'document' | 'view' | 'proposal' | 'inbox_item'
  object_id         UUID        NOT NULL,
  -- ^ Polymorphic — no FK enforced (validated at app layer)
  relationship_type TEXT        NOT NULL,
  -- ^ 'used_as_context' | 'created' | 'updated' | 'referenced' | 'inherited_from_parent'
  conflict_status   TEXT        NOT NULL DEFAULT 'none',
  -- ^ 'none' | 'pending' | 'resolved'
  source_message_id UUID        REFERENCES messages(id) ON DELETE SET NULL,
  -- Note: source_event_id omitted — events is TimescaleDB hypertable (no FK support)
  user_id           TEXT        NOT NULL,
  workspace_id      UUID        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT channel_context_unique
    UNIQUE (channel_id, object_id, object_type, relationship_type)
);

CREATE INDEX IF NOT EXISTS channel_context_channel_idx
  ON channel_context_items(channel_id);
CREATE INDEX IF NOT EXISTS channel_context_object_idx
  ON channel_context_items(object_type, object_id);
CREATE INDEX IF NOT EXISTS channel_context_user_idx
  ON channel_context_items(user_id);
CREATE INDEX IF NOT EXISTS channel_context_workspace_idx
  ON channel_context_items(workspace_id);
CREATE INDEX IF NOT EXISTS channel_context_conflict_idx
  ON channel_context_items(conflict_status)
  WHERE conflict_status != 'none';


-- ============================================================
-- Step 5: Migrate thread_entities → channel_context_items
-- ============================================================

INSERT INTO channel_context_items
  (id, channel_id, object_type, object_id, relationship_type,
   conflict_status, source_message_id, user_id, workspace_id, created_at)
SELECT
  id,
  thread_id,
  'entity',
  entity_id,
  relationship_type,
  conflict_status,
  source_message_id,
  user_id,
  workspace_id,
  created_at
FROM thread_entities
ON CONFLICT (channel_id, object_id, object_type, relationship_type) DO NOTHING;


-- ============================================================
-- Step 6: Migrate thread_documents → channel_context_items
-- ============================================================

INSERT INTO channel_context_items
  (id, channel_id, object_type, object_id, relationship_type,
   conflict_status, source_message_id, user_id, workspace_id, created_at)
SELECT
  id,
  thread_id,
  'document',
  document_id,
  relationship_type,
  conflict_status,
  source_message_id,
  user_id,
  workspace_id,
  created_at
FROM thread_documents
ON CONFLICT (channel_id, object_id, object_type, relationship_type) DO NOTHING;


-- ============================================================
-- Step 7: Drop old tables
-- ============================================================

DROP TABLE IF EXISTS thread_entities;
DROP TABLE IF EXISTS thread_documents;


-- ============================================================
-- Notes on automatically-handled FKs:
--   - proposals.thread_id         → references channels(id)  [table renamed, no SQL change]
--   - command_runs.thread_id       → references channels(id)  [table renamed, no SQL change]
--   - message_links.message_id     → references messages(id)  [table renamed, no SQL change]
--   - channels.branchedFromMessageId is NOT a FK in Drizzle (self-ref cycle avoided)
-- ============================================================
