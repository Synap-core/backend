-- 0356: box runs — a script run queued in the pod, leased by the person's own
-- computer (code-runtime plan v2 point C, run box design C4/C8 phase 0).
--
-- A skill with `execution_mode = 'box'` does not run in the pod. Running it
-- (the person's own run, or an agent's approved one) writes ONE row here,
-- `queued`. A computer the person connected (`users.agent_type = 'machine'`,
-- key scope `box.runner`) leases the head of its person's queue over Hub REST,
-- starts a fresh box, heartbeats, and finishes the run with its evidence
-- (exit code, duration, log head/tail, blocked egress, installed packages).
-- Output files land through the existing upload door as the requester.
--
-- `spec` is the script AS QUEUED (code, language, packages, hosts, limits): an
-- edit to the skill after queueing never changes what a queued run executes.
--
-- Lease: `lease_id` is minted at each lease; heartbeat/finish must present it,
-- so a provisioner whose lease expired (and was re-leased) is refused.
-- A `leased` run whose lease expired goes back to the queue (the box never ran
-- the script). A `running` run whose lease expired is read as STALLED and is
-- never re-leased (the script may have had side effects). `stalled` is a READ
-- verdict, never stored.
--
-- Read floor: the requester (`user_id`), within the workspace lens
-- (`workspaceOwned`, access/registry.ts). Never read by the computer except
-- through the lease routes, which floor on the computer's own person.

CREATE TABLE IF NOT EXISTS "box_runs" (
  "id"                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "skill_id"           uuid        REFERENCES "skills"("id") ON DELETE SET NULL,
  "user_id"            text        NOT NULL,
  "agent_user_id"      text,
  "session_id"         uuid,
  "workspace_id"       uuid,
  "proposal_id"        uuid,
  "spec"               jsonb       NOT NULL,
  "parameters"         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "status"             text        NOT NULL DEFAULT 'queued',
  "attempt"            integer     NOT NULL DEFAULT 0,
  "leased_by"          text,
  "lease_id"           uuid,
  "lease_expires_at"   timestamptz,
  "last_heartbeat_at"  timestamptz,
  "stop_requested_at"  timestamptz,
  "evidence"           jsonb,
  "error"              text,
  "queued_at"          timestamptz NOT NULL DEFAULT now(),
  "leased_at"          timestamptz,
  "started_at"         timestamptz,
  "finished_at"        timestamptz,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'box_runs_status_check'
  ) THEN
    ALTER TABLE "box_runs" ADD CONSTRAINT "box_runs_status_check"
      CHECK ("status" IN ('queued', 'leased', 'running', 'done', 'failed', 'stopped'));
  END IF;
END $$;

-- The queue head, per requester (FIFO by queued_at).
CREATE INDEX IF NOT EXISTS "idx_box_runs_queue"
  ON "box_runs" ("user_id", "queued_at")
  WHERE "status" IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS "idx_box_runs_user_queued"
  ON "box_runs" ("user_id", "queued_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_box_runs_session"
  ON "box_runs" ("session_id")
  WHERE "session_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_box_runs_skill"
  ON "box_runs" ("skill_id")
  WHERE "skill_id" IS NOT NULL;
