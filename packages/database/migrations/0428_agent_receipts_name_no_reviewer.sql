-- 0428_agent_receipts_name_no_reviewer
--
-- AN AUTOMATIC RECEIPT NAMES NO REVIEWER (plan 8032a127 D4, finding d4d20c02,
-- founder-validated 17 Nov 2026). `proposals.reviewed_by` is the PERSON who
-- decided: activity's `decision` source, the approver on display and the
-- session timeline all read it so. The capture doors stamped the person on an
-- agent's auto-applied receipt (`createAutoApprovedProposal`, and the
-- re-decision of an agent's revised graph), so each one, and each of its
-- failures, read as the founder deciding. On the founder's pod (Hub read,
-- 17 Nov): 1,735 auto_approved agent receipts and 10 approval_failed ones
-- (7ad8bdde, 59a4d97e, 5dc1d238, bf5c7e94, ebb958fa, ...). The code now stamps
-- no reviewer there; this clears the rows already written.
--
-- 1. The agent first. A capture receipt filed before 20 Oct (9f1f7c005) has
--    `data.source = 'agent'` but no `agent_user_id`: nothing on the row says an
--    agent did it (168 rows on that pod, July to 22 Oct). It is recorded
--    from the receipt's session when that session was the agent's (origin
--    'agent') and its roster holds exactly ONE agent that still exists: 120
--    of the 168 there. Any other row keeps its null (no session, a playbook
--    run's session, an empty roster): never a guess. Step 2 still clears its
--    reviewer, by `data.source`.
--
-- 2. Then the reviewer, on agent receipts only (an agent recorded, or
--    `data.source = 'agent'`). A person's own first-party capture keeps the
--    person: they did it.
--    - auto_approved: every agent receipt with a reviewer. No person's act
--      makes a row auto_approved (a person's approve writes `approved`), so
--      a reviewer on one came from the receipt write itself.
--    - approval_failed: only a capture receipt whose review stamp is its own
--      creation (within one second): a failure of the write itself. A person
--      who approved a pending capture that then failed (6253b035, 26 Oct)
--      keeps their name: they did decide.
--    `reviewed_at` stays: it says when the row settled.
--
-- No column is added. Re-runnable: each UPDATE matches nothing a second time.

UPDATE "proposals" AS p
SET "agent_user_id" = fs."agent_ids"[1]
FROM "focus_sessions" AS fs
WHERE p."session_id" = fs."id"
  AND p."agent_user_id" IS NULL
  AND p."proposal_type" = 'capture.graph'
  AND p."data"->>'source' = 'agent'
  AND fs."origin" = 'agent'
  AND cardinality(fs."agent_ids") = 1
  AND EXISTS (SELECT 1 FROM "users" AS u WHERE u."id" = fs."agent_ids"[1]);

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
