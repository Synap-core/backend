-- 0023_channel_v2_restore.sql
-- Phase 1: Restore V2 channelType vocabulary — add `personal` + `sub_thread`
-- alongside the existing `thread | feed | external | agent_collab` types.
--
-- Spec: synap-team-docs/content/team/platform/channel-system.mdx
--
-- Background: V2 was meant to ship 6 canonical channelTypes. The pod drifted
-- into 4 types + a `thread_kind` discriminator (later dropped in 0010), which
-- collapsed `personal` and `sub_thread` into `thread`. This migration walks
-- that back additively — old rows are reclassified, new code uses the new
-- vocabulary, but `thread_kind` legacy data is preserved best-effort (the
-- column itself was already dropped in 0010 — see notes below).
--
-- channel_type is a TEXT column with no Postgres CHECK constraint (see
-- 0000_baseline_schema.sql line 818). Drizzle's `enum:[]` is a TS-only check;
-- the live DB will accept any string. So we don't need ALTER TYPE — just
-- UPDATE rows and ship the new TS enum.
--
-- Idempotent: every UPDATE is guarded by a WHERE that ignores rows already
-- in the target state. Re-running this migration is a no-op.

BEGIN;

-- ─── Backfill: derive personal/sub_thread from existing data ─────────────────
--
-- thread_kind was dropped in 0010, so we can't use it. Instead, derive from
-- the structural fields that remain:
--
--   personal channel — pod-scoped, has assignedAgentId, no workspaceId,
--                      no parentChannelId. This matches the shape that
--                      ensureAgentThread() has been writing since 0014.
--
--   sub_thread       — any thread that has a parentChannelId. Branches were
--                      the only kind of thread that ever had a parent.

UPDATE channels
   SET channel_type = 'personal'
 WHERE channel_type = 'thread'
   AND workspace_id IS NULL
   AND parent_channel_id IS NULL
   AND assigned_agent_id IS NOT NULL
   AND scope = 'pod';

UPDATE channels
   SET channel_type = 'sub_thread'
 WHERE channel_type = 'thread'
   AND parent_channel_id IS NOT NULL;

COMMIT;
