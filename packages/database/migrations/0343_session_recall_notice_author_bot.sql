-- 0343 — the session-recall notice is the POD speaking, not the person.
--
-- `postChannelMessage` used to stamp `author_type = 'human'` on every post that
-- named no agent, so the notice a starting session posts in its room ("Found N
-- things you captured earlier that may help this session: …") was stored as
-- the session owner's own words (role 'assistant', author_type 'human',
-- user_id = the owner). The door now stamps 'bot' for a pod-authored post; this
-- repairs the rows written before.
--
-- The discriminator is the notice's fixed copy (`formatRecallMessage`) on an
-- ASSISTANT-role row with no routed agent, in a room some focus session owns.
-- A person cannot write that: a person's post is role 'user'. It is deliberately
-- NOT "every assistant+human row": the connector egress records a person's
-- authorised outbound send the same way on purpose.
--
-- Idempotent: after one run no row matches `author_type = 'human'` any more.
-- The tamper hash covers (id, content, previous_hash) only, so it is untouched.
UPDATE "messages"
SET "author_type" = 'bot'
WHERE "role" = 'assistant'
  AND "author_type" = 'human'
  AND "routed_teammate_id" IS NULL
  AND "content" ~ '^Found [0-9]+ things? you captured earlier that may help this session:'
  AND "channel_id" IN (
    SELECT "channel_id" FROM "focus_sessions" WHERE "channel_id" IS NOT NULL
  );
