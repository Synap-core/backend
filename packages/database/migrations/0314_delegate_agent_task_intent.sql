-- 0314 — delegate_agent_task intent
--
-- What a capability DOES is a row, not a TypeScript union (0283).
-- delegate_agent_task is an ACT: a verb that hands a piece of work to an
-- EXTERNAL agent (a coding agent, a hosted assistant) through its binding tool
-- (`tools.config.agentBinding`) and keeps the conversation going — start, send,
-- status, cancel. Every verb an agent binding lists carries this intent.
-- ABSTRACT_VERBS stays the seed only — this slug is a post-seed row
-- (REGISTERED_EXTRAS), exactly like publish_post (0284). The table already
-- exists (0283, and 0000_baseline_schema.sql on a fresh install); this file
-- only inserts the row.

INSERT INTO "capability_intents" ("slug", "effect", "statement")
VALUES
  ('delegate_agent_task', 'act', 'Hand a piece of work to an external agent and keep the conversation going.')
ON CONFLICT ("slug") DO NOTHING;
