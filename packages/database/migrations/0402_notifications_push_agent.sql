-- 0402: which AGENT a pushed notification was about (push levels, founder
-- decision 9bc9f75c, 2026-11-04).
--
-- A person may set a daily push limit on one agent, in that agent's settings
-- (`users.agent_metadata.pushDailyLimit`; none by default: "it is not limited
-- (for now) but agents settings could setup a limit per agent").
-- `NotificationService.create` stamps `push_agent_id` with `pushed_at` when it
-- knows the agent (the one that asked, filed the proposal or relayed the
-- answer); `push-decision.ts` counts that agent's pushes since the start of
-- the person's day. NULL = not pushed, or no agent known. No backfill.
--
-- Plain (not CONCURRENTLY): the migration runner applies each file in a
-- transaction. Idempotent.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "push_agent_id" text;

CREATE INDEX IF NOT EXISTS "notifs_user_push_agent_idx"
  ON "notifications" ("user_id", "push_agent_id", "pushed_at")
  WHERE "push_agent_id" IS NOT NULL;
