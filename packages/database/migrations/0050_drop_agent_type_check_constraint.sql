-- Migration: Drop stale agent_type CHECK constraint from channels table
--
-- Background:
--   Migration 0011_fix_chat_threads_schema.sql added a CHECK constraint on
--   chat_threads.agent_type restricting values to:
--     ('default', 'meta', 'prompting', 'knowledge-search', 'code', 'writing', 'action')
--
--   Migration 0038_channels_refactor.sql renamed chat_threads → channels but left
--   the constraint in place (under its old name 'chat_threads_agent_type_check').
--
--   The current codebase defines many more agent types (personal, orchestrator,
--   onboarding, insight-discovery, view-builder, workspace-builder, workspace-creation,
--   action, a2ai, etc.) that are NOT in the old constraint.  Any INSERT with one of
--   these types fails with a constraint-violation 500, including the core
--   ensurePersonalChannel() call (agentType = 'personal') that backs every
--   chat.getPersonalChannel tRPC request.
--
--   The Drizzle schema defines agent_type as plain TEXT with no DB-level enum —
--   validation is handled at the application layer.  The CHECK constraint is
--   therefore both incorrect and unnecessary.

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS chat_threads_agent_type_check;
