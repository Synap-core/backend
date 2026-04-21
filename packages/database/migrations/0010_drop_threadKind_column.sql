-- 0010_drop_threadKind_column.sql
-- Drop the threadKind column entirely from the channels table.
--
-- Background: after earlier cleanup (0009), threadKind was reduced to a single-value
-- enum (branch) but served no active purpose — branch semantics are now derived
-- from parentChannelId + context fields + agentType. Dropping it simplifies the
-- schema with no loss of meaning.

BEGIN;

-- Drop any indexes on the column (0009 already dropped channels_thread_kind_idx,
-- but this is a safety net for any future indexes).
DROP INDEX IF EXISTS channels_thread_kind_idx;

-- Drop the column. CASCADE to handle any constraints that reference it.
ALTER TABLE channels DROP COLUMN IF EXISTS thread_kind;

COMMIT;
