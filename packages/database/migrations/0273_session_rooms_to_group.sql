-- 0273 — session rooms become GROUP rooms
--
-- Founder decision 2026-09-24: a focus session's room is a real multi-actor
-- room (several humans + AI agents) where an AI answers only when @-mentioned.
-- The mint (`ensureSessionChannel`) now creates `channel_type = 'group'` +
-- `ai_reaction_mode = 'only_mentioned'` and seeds the roster; this converts the
-- rooms minted before it and backfills their roster.
--
-- THE KEY IS THE CONTEXT STAMP, NOT focus_sessions.channel_id. A session may
-- BORROW an existing channel (createSession({ channelId }), a playbook run's
-- targetChannelId) — the chat it started in, a client's team channel. Keying on
-- the FK would turn someone's assistant thread into a mention-only room. Only
-- the mint stamps `context_object_type = 'focus_session'`, so these are exactly
-- the minted session rooms — and the SAME key `channelVisibilityWhere` uses to
-- make them roster-only, so every converted row is roster-only by construction.
-- Only 'thread' rows convert: personal / external / run / agent_collab are
-- never touched.
--
-- ORDERING: deploy WITH the code that (1) lets the auto-respond door wake a
-- GROUP room for a named agent, (2) keeps anchored comments waking in GROUP,
-- (3) makes session rooms roster-only. Without (3) a converted pod-scoped room
-- is visible to the whole pod.
--
-- No new column ⇒ no baseline / schema-coherence change. Idempotent: re-running
-- converts nothing new and every insert is ON CONFLICT DO NOTHING.

-- 1. Convert. ------------------------------------------------------------------
UPDATE "channels"
SET "channel_type" = 'group',
    "ai_reaction_mode" = 'only_mentioned',
    "updated_at" = now()
WHERE "context_object_type" = 'focus_session'
  AND "channel_type" = 'thread';

-- 2. Roster: the room owner (HUMAN / owner). --------------------------------------
INSERT INTO "channel_members" ("channel_id", "member_id", "member_kind", "role", "added_by")
SELECT c."id", c."user_id", 'human', 'owner', c."user_id"
FROM "channels" c
WHERE c."context_object_type" = 'focus_session'
  AND c."channel_type" = 'group'
ON CONFLICT ("channel_id", "member_id") DO NOTHING;

-- 3. Roster: the session's owner, when it differs from the room's (HUMAN). ------
INSERT INTO "channel_members" ("channel_id", "member_id", "member_kind", "role", "added_by")
SELECT DISTINCT c."id", fs."user_id", 'human', 'member', c."user_id"
FROM "channels" c
JOIN "focus_sessions" fs ON fs."channel_id" = c."id"
WHERE c."context_object_type" = 'focus_session'
  AND c."channel_type" = 'group'
  AND fs."user_id" IS NOT NULL
ON CONFLICT ("channel_id", "member_id") DO NOTHING;

-- 4. Roster: the session's staffed agents (focus_sessions.agent_ids). -----------
INSERT INTO "channel_members" ("channel_id", "member_id", "member_kind", "role", "added_by")
SELECT DISTINCT c."id", a.agent_id, 'ai_agent', 'member', c."user_id"
FROM "channels" c
JOIN "focus_sessions" fs ON fs."channel_id" = c."id"
CROSS JOIN LATERAL unnest(fs."agent_ids") AS a(agent_id)
WHERE c."context_object_type" = 'focus_session'
  AND c."channel_type" = 'group'
  AND a.agent_id IS NOT NULL
  AND a.agent_id <> ''
  AND a.agent_id <> c."user_id"
ON CONFLICT ("channel_id", "member_id") DO NOTHING;

-- 5. Roster: the owner's personal orchestrator — what "@ai" resolves to. --------
INSERT INTO "channel_members" ("channel_id", "member_id", "member_kind", "role", "added_by")
SELECT c."id", u."id", 'ai_agent', 'member', c."user_id"
FROM "channels" c
JOIN "users" u
  ON u."created_by_user_id" = c."user_id"
 AND u."user_type" = 'agent'
 AND u."is_personal_agent" = true
WHERE c."context_object_type" = 'focus_session'
  AND c."channel_type" = 'group'
ON CONFLICT ("channel_id", "member_id") DO NOTHING;
