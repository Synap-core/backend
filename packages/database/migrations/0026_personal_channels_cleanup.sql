-- 0026_personal_channels_cleanup.sql
-- Complete the V2 channel vocabulary migration started in 0023.
--
-- 0023 reclassified pod-scoped personal channels (workspace_id IS NULL).
-- It missed channels created before the pod-wide logic existed — those were
-- written as `thread` with a non-null workspace_id + assigned_agent_id and
-- no parent. They are personal channels that happened to have a workspace_id
-- stamped on them at creation time.
--
-- This migration:
--   1. Reclassifies all remaining personal-shaped THREAD rows to PERSONAL
--      and clears their workspace_id so they are truly pod-wide.
--   2. No rows are deleted — only type + workspace_id are updated.
--
-- Idempotent: guarded by WHERE channel_type = 'thread'.

BEGIN;

UPDATE channels
   SET channel_type  = 'personal',
       workspace_id  = NULL,
       scope         = 'pod'
 WHERE channel_type      = 'thread'
   AND assigned_agent_id IS NOT NULL
   AND parent_channel_id IS NULL;

COMMIT;
