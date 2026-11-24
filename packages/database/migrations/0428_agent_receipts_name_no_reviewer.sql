-- 0428_agent_receipts_name_no_reviewer
--
-- An agent's auto-applied receipt names no reviewer (plan 8032a127 D4, see
-- `createAutoApprovedProposal`). This clears the rows written before the fix.
-- No column is added; each UPDATE matches nothing a second time.

-- 1. Record the agent on capture receipts filed before agents were recorded
--    (`data.source = 'agent'`, no `agent_user_id`), from their session when
--    that session was one agent's: origin 'agent', exactly one roster agent
--    that still exists. Receipts only: a pending row given an agent would
--    count toward that agent's pending cap. Any other row stays unknown,
--    never a guess.

UPDATE "proposals" AS p
SET "agent_user_id" = fs."agent_ids"[1]
FROM "focus_sessions" AS fs
WHERE p."session_id" = fs."id"
  AND p."agent_user_id" IS NULL
  AND p."status" IN ('auto_approved', 'approval_failed')
  AND p."proposal_type" = 'capture.graph'
  AND p."data"->>'source' = 'agent'
  AND fs."origin" = 'agent'
  AND cardinality(fs."agent_ids") = 1
  AND EXISTS (SELECT 1 FROM "users" AS u WHERE u."id" = fs."agent_ids"[1]);

-- 2. Clear the reviewer on agent receipts only: an agent is recorded, or
--    `data.source = 'agent'` (the predicate `createAutoApprovedProposal`
--    uses; step 1 cannot name every agent). A person's capture keeps them.
--    auto_approved: no person's act makes a row auto_approved, so its reviewer
--    came from the receipt write. approval_failed: only a capture receipt
--    reviewed within one second of its creation (the write itself failed); a
--    person who approved a capture that later failed keeps their name.
--    `reviewed_at` stays: when the row settled.

UPDATE "proposals"
SET "reviewed_by" = NULL
WHERE "reviewed_by" IS NOT NULL
  AND ("agent_user_id" IS NOT NULL OR "data"->>'source' = 'agent')
  AND (
    "status" = 'auto_approved'
    OR (
      "status" = 'approval_failed'
      AND "proposal_type" = 'capture.graph'
      AND "reviewed_at" IS NOT NULL
      AND abs(extract(epoch FROM ("reviewed_at" - "created_at"))) < 1
    )
  );
