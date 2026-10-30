-- 0381 — "Never" and "Later" on a request (founder decision G3, 30 Oct 2026)
--
-- A request offers three answers: this time / always for this agent and this
-- kind of act / never. Two storage changes carry the last two words:
--
-- 1. `governance_verdict` gains `deny`: a person's stored "Never". From then
--    on the resolver refuses that agent's write of that kind with the typed
--    reason `DENIED_BY_RULE` (`resolveGovernanceRule`, `decideAgentPolicy`
--    rung 1.5, the capability gate). Ranked like every rule (most specific
--    wins); on a tie, `deny` beats `auto` and `propose`.
--
-- 2. `proposal_snoozes`: "Later" sets a request aside FOR ONE PERSON until a
--    time, with no change to governance. The needs-you rule reads it as Review
--    later for that person only (`classifyPendingProposal`); every other
--    reader still counts the request. One row per (proposal, person); a later
--    "Later" moves the time. Deleted with its proposal.
--
-- TRANSACTION NOTE: as 0266 and 0330 — `ALTER TYPE … ADD VALUE` is legal
-- inside the migration transaction on Postgres 12+ when the value is not used
-- in it. Idempotent. Mirrored into 0000_baseline_schema.sql.

ALTER TYPE governance_verdict ADD VALUE IF NOT EXISTS 'deny';

CREATE TABLE IF NOT EXISTS "proposal_snoozes" (
  "proposal_id"    uuid NOT NULL REFERENCES "proposals"("id") ON DELETE CASCADE,
  "user_id"        text NOT NULL,
  "snoozed_until"  timestamptz NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("proposal_id", "user_id")
);

-- The needs-you read asks "which of THESE proposals has this person set
-- aside?": one person, a page of proposal ids.
CREATE INDEX IF NOT EXISTS "proposal_snoozes_user_idx"
  ON "proposal_snoozes" ("user_id", "snoozed_until");
