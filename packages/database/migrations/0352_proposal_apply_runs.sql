-- 0352: proposal apply runs — a LARGE approval applied by a background job.
--
-- Approving a 4,222-operation import used to run inside the HTTP request at
-- ~5 creates per second: the button spun for ~15 minutes and a proxy timeout
-- could cut the request mid-apply (founder, 2026-10-23, proposal abc79426).
-- A composite proposal at or above the background threshold is now handed to
-- the `proposal-approve` pg-boss queue AFTER the approve door's gates, and the
-- job applies it through the same approval door. This row is what the job
-- writes as it goes and what every reader polls: one row per attempt.
--
-- `user_id` = the approver (the authorizer of every row the run creates).
-- Read floor = the proposal's (`assertProposalVisibleTo`); the row is only
-- ever read through its proposal, never by its own id.
--
-- At most ONE queued/running attempt per proposal (partial unique index): a
-- second approve joins the running one instead of applying the graph twice.

CREATE TABLE IF NOT EXISTS "proposal_apply_runs" (
  "id"                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "proposal_id"          uuid        NOT NULL REFERENCES "proposals"("id") ON DELETE CASCADE,
  "user_id"              text        NOT NULL,
  "status"               text        NOT NULL DEFAULT 'queued',
  "phase"                text,
  "total"                integer     NOT NULL DEFAULT 0,
  "done"                 integer     NOT NULL DEFAULT 0,
  "created"              integer     NOT NULL DEFAULT 0,
  "linked"               integer     NOT NULL DEFAULT 0,
  "failed"               integer     NOT NULL DEFAULT 0,
  "input"                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "via_app"              jsonb,
  "request_workspace_id" text,
  "revision"             integer     NOT NULL DEFAULT 0,
  "job_id"               text,
  "error"                text,
  "error_class"          text,
  "result"               jsonb,
  "heartbeat_at"         timestamptz NOT NULL DEFAULT now(),
  "started_at"           timestamptz,
  "finished_at"          timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_proposal_apply_runs_active"
  ON "proposal_apply_runs" ("proposal_id")
  WHERE "status" IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS "idx_proposal_apply_runs_proposal_created"
  ON "proposal_apply_runs" ("proposal_id", "created_at");
