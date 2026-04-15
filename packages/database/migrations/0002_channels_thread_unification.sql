-- 0002_channels_thread_unification.sql
-- Breaking channel model cleanup:
-- - Canonical channel types: thread, feed, external, agent_collab
-- - Personal and branch semantics move to channels.thread_kind
-- - Legacy skill trigger channel target "personal" -> "personal_thread"

BEGIN;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS thread_kind text;

-- Normalize legacy channel type variants to canonical types.
UPDATE channels
SET channel_type = 'thread'
WHERE channel_type IN (
  'personal',
  'sub_thread',
  'ai_thread',
  'entity_comments',
  'document_review',
  'view_discussion',
  'direct'
);

UPDATE channels
SET channel_type = 'external'
WHERE channel_type = 'external_import';

UPDATE channels
SET channel_type = 'agent_collab'
WHERE channel_type = 'a2ai';

-- Derive thread_kind for unified thread model.
UPDATE channels
SET thread_kind = 'branch'
WHERE channel_type = 'thread'
  AND parent_channel_id IS NOT NULL
  AND thread_kind IS NULL;

UPDATE channels
SET thread_kind = 'personal'
WHERE channel_type = 'thread'
  AND workspace_id IS NULL
  AND thread_kind IS NULL;

UPDATE channels
SET thread_kind = 'entity'
WHERE channel_type = 'thread'
  AND context_object_type = 'entity'
  AND thread_kind IS NULL;

UPDATE channels
SET thread_kind = 'document'
WHERE channel_type = 'thread'
  AND context_object_type = 'document'
  AND thread_kind IS NULL;

UPDATE channels
SET thread_kind = 'view'
WHERE channel_type = 'thread'
  AND context_object_type = 'view'
  AND thread_kind IS NULL;

UPDATE channels
SET thread_kind = 'project'
WHERE channel_type = 'thread'
  AND context_object_type = 'project'
  AND thread_kind IS NULL;

UPDATE channels
SET thread_kind = 'task'
WHERE channel_type = 'thread'
  AND context_object_type = 'task'
  AND thread_kind IS NULL;

UPDATE channels
SET thread_kind = 'workspace'
WHERE channel_type = 'thread'
  AND context_object_type = 'workspace'
  AND thread_kind IS NULL;

UPDATE channels
SET thread_kind = 'workspace'
WHERE channel_type = 'thread'
  AND thread_kind IS NULL;

-- Scope normalization for personal-style threads.
UPDATE channels
SET scope = 'pod'
WHERE channel_type = 'thread'
  AND thread_kind = 'personal';

-- Skill triggers: align to renamed trigger target value.
UPDATE skill_triggers
SET channel_type = 'personal_thread'
WHERE channel_type = 'personal';

CREATE INDEX IF NOT EXISTS channels_thread_kind_idx
  ON channels (thread_kind);

COMMIT;
