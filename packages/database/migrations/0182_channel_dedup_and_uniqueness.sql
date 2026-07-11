-- Migration: 0182_channel_dedup_and_uniqueness
--
-- ROOT CAUSE: migration 0014 created the personal / workspace-group uniqueness
-- indexes keyed on `thread_kind` ('personal' / 'workspace'). `thread_kind` was
-- retired in the V2 channel model (left NULL for every new row — see
-- resolve-or-create-channel.ts). A partial index `WHERE thread_kind = 'personal'`
-- therefore matches ZERO live rows and enforces NOTHING. With no DB guard and
-- three separate copies of the feed/personal resolvers, duplicate personal,
-- workspace-group, and proactive-feed channels accumulate — the observable
-- "proactive AI creates a new channel every time / posts scatter" bug.
--
-- FIX (idempotent, one transaction — the runner wraps the file in sql.begin):
--   1. Archive existing duplicates: keep the OLDEST active row per logical key,
--      mark the rest status='merged'. Oldest-wins matches the resolvers' new
--      asc(created_at) order, so resolution and the DB agree on the survivor.
--      Messages stay intact in the merged channel (readable, just out of the
--      active partial index).
--   2. Drop the dead thread_kind-keyed indexes.
--   3. Re-cut them on the LIVE `channel_type` column, and add the missing FEED
--      uniqueness. These become the substrate the canonical resolveChannel door's
--      onConflictDoNothing upserts target (mirrors channels_external_source_id_unique).
--
-- Feed note: the only feed creator (ensureProactiveFeedChannel) makes exactly one
-- pod-wide feed per user and resolves one-per-user (it ignores workspace), so the
-- feed uniqueness keys on (user_id) alone — the resolver's true contract, and a
-- plain-column partial index with a clean ON CONFLICT arbiter (no NULL-distinct
-- pitfall, no expression index). Workspace-scoped feeds are undefined today; if
-- ever added they get their own future migration.

-- 0. Mark existing agent-INSTANCE threads. A template DM and an instance thread
--    both carry assigned_agent_id = the same template, but an instance thread is
--    dedup'd on channel_members (one per user×instance), NOT on the template. They
--    are identical at the row level EXCEPT an instance thread has an ai_agent
--    channel_members row. Stamp them so the dedup below + the unique index can
--    exclude them (else two instances of one template are wrongly merged/collide).
--    Going forward ensureAgentInstanceThread stamps this marker itself.
UPDATE channels c
SET metadata = COALESCE(c.metadata, '{}'::jsonb) || '{"agentInstanceThread": true}'::jsonb
WHERE c.channel_type = 'personal'
  AND (c.metadata ->> 'agentInstanceThread') IS NULL
  AND EXISTS (
    SELECT 1 FROM channel_members cm
    WHERE cm.channel_id = c.id AND cm.member_kind = 'ai_agent'
  );

-- 1a. Personal TEMPLATE DMs — one active per (user, template). Instance threads
--     (marked above) are excluded — their uniqueness is the channel_members key.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, assigned_agent_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM channels
  WHERE channel_type = 'personal'
    AND assigned_agent_id IS NOT NULL
    AND status = 'active'
    AND (metadata ->> 'agentInstanceThread') IS NULL
)
UPDATE channels c
SET status = 'merged', updated_at = now()
FROM ranked
WHERE c.id = ranked.id AND ranked.rn > 1;

-- 1b. Workspace-group threads — one active per (user, workspace).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, workspace_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM channels
  WHERE channel_type = 'thread'
    AND context_object_type = 'workspace'
    AND status = 'active'
)
UPDATE channels c
SET status = 'merged', updated_at = now()
FROM ranked
WHERE c.id = ranked.id AND ranked.rn > 1;

-- 1c. Feed channels — one active per user (workspace ignored, per the resolver).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM channels
  WHERE channel_type = 'feed'
    AND status = 'active'
)
UPDATE channels c
SET status = 'merged', updated_at = now()
FROM ranked
WHERE c.id = ranked.id AND ranked.rn > 1;

-- 2. Drop the dead thread_kind-keyed indexes (they enforce nothing).
DROP INDEX IF EXISTS channels_user_agent_personal_uniq;
DROP INDEX IF EXISTS channels_user_workspace_group_uniq;

-- 3. Re-cut on the LIVE channel_type column + add the missing FEED uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS channels_user_agent_personal_uniq
  ON channels (user_id, assigned_agent_id)
  WHERE channel_type = 'personal'
    AND assigned_agent_id IS NOT NULL
    AND status = 'active'
    -- Exclude agent-INSTANCE threads: they share assigned_agent_id with the
    -- template DM + sibling instances but are dedup'd on channel_members.
    AND (metadata ->> 'agentInstanceThread') IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS channels_user_workspace_group_uniq
  ON channels (user_id, workspace_id)
  WHERE channel_type = 'thread'
    AND context_object_type = 'workspace'
    AND status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS channels_user_feed_uniq
  ON channels (user_id)
  WHERE channel_type = 'feed'
    AND status = 'active';
