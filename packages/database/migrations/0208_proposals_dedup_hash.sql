-- Migration: 0208_proposals_dedup_hash.sql
--
-- Dedup-seams G3: stored dedup hash + partial unique index for agent proposals.
--
-- The agent-proposal dedup guard used to hash candidates at READ time (an
-- unbounded scan) and left a concurrent-insert race open — two simultaneous
-- identical agent writes both peek empty, both insert, and a duplicate PENDING
-- proposal lands. This column stores the normalized change hash
-- (computeProposalDedupHash) for agent/automation-authored rows, and the partial
-- unique index makes a duplicate PENDING agent proposal a DB-level
-- impossibility: the read-then-insert peek closes the common case, the index
-- closes the race (the losing INSERT hits SQLSTATE 23505, the writer re-peeks
-- and returns the winner). NULL for human-authored proposals — a person may
-- deliberately file the same change twice, so they are never deduped and never
-- constrained.
--
-- GLOBAL dedup (ratified): the index is on dedup_hash ALONE (the hash excludes
-- agentUserId), so a different agent proposing the identical change dedups onto
-- the first pending proposal rather than filing a duplicate. findExistingPending
-- Duplicate peeks with the same global scope; a concurrent race that slips past
-- the peek and hits this index (23505) is recovered by a global re-peek, never
-- surfaced as an error.
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "dedup_hash" text;

CREATE UNIQUE INDEX IF NOT EXISTS "proposals_agent_dedup_uq"
  ON "proposals" ("dedup_hash")
  WHERE status = 'pending' AND agent_user_id IS NOT NULL AND dedup_hash IS NOT NULL;
