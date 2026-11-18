-- 0431 — the `compute` need and the compute leases (plan a640c5bb B3,
-- ticket 5f3c3a7d; founder decisions of 18 Nov 2026).
--
-- THE NEED. `compute` is the seat a cloud provider fills (0426): start a
-- temporary machine (provision_compute, 0429), run a job on it
-- (run_external_job), read its state and outputs (fetch_record), stop or
-- destroy it (release_compute, 0429). A pack declares it `fills` compute.
-- Mirrored in `@synap-core/types/needs` and the control plane's
-- `src/seeds/need-vocabulary.ts`, each guard listing this file.
--
-- THE LEASES. Every compute start leaves ONE row, written before the
-- provider is called (no row, no start): who started it, the provision verb
-- and the release verb it declares, its time to live and spend maximum, and,
-- once the start answered, the provider's id of the machine. The TTL sweeper
-- (`compute-lease-sweeper`, every 5 min) runs the release verb in mode
-- `destroy` on every active lease past `expires_at`. The start's approval
-- covers that destroy (founder, 18 Nov 2026): it runs with no second review,
-- recorded on the lease and on the start's proposal (`data.computeRelease`).
--
-- States: starting (written, provider not yet answered) · active (the
-- machine exists, `resource_id` set) · released (destroyed) · not_started
-- (the start did not run) · unknown (the start ran but returned no machine
-- id: a person must look).
--
-- `max_spend_cents` is the start's declared maximum, never a measured spend:
-- the compute spend ceiling (0430) sums it per UTC day.
-- Owner-floored (`user_id`), never read outside the run doors and the sweeper.

INSERT INTO "needs" ("slug", "label", "description", "intents", "aliases")
VALUES
  ('compute', 'Compute', 'Where temporary machines are started, run jobs and are released.',
   ARRAY['provision_compute', 'run_external_job', 'fetch_record', 'release_compute'], ARRAY['cloud-compute', 'gpu'])
ON CONFLICT ("slug") DO NOTHING;

CREATE TABLE IF NOT EXISTS "compute_leases" (
  "id"                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"              text        NOT NULL,
  "workspace_id"         uuid,
  "agent_user_id"        text,
  "proposal_id"          uuid,
  "session_id"           uuid,
  "provision_skill_id"   uuid,
  "provision_verb"       text        NOT NULL,
  "release_verb"         text        NOT NULL,
  "connection_selector"  jsonb,
  "resource_id"          text,
  "ttl_minutes"          integer     NOT NULL,
  "max_spend_cents"      integer     NOT NULL,
  "state"                text        NOT NULL DEFAULT 'starting',
  "expires_at"           timestamptz NOT NULL,
  "release_attempts"     integer     NOT NULL DEFAULT 0,
  "last_release_error"   text,
  "release_result"       jsonb,
  "released_at"          timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "compute_leases_state_check"
    CHECK ("state" IN ('starting', 'active', 'released', 'not_started', 'unknown')),
  CONSTRAINT "compute_leases_ttl_check" CHECK ("ttl_minutes" > 0),
  CONSTRAINT "compute_leases_spend_check" CHECK ("max_spend_cents" > 0)
);

-- The sweeper's read: active leases past their TTL.
CREATE INDEX IF NOT EXISTS "compute_leases_due_idx"
  ON "compute_leases" ("expires_at") WHERE "state" = 'active';
-- The ceiling's read: the day's starts.
CREATE INDEX IF NOT EXISTS "compute_leases_created_idx"
  ON "compute_leases" ("created_at");
-- A manual destroy closes the lease of the machine it names.
CREATE INDEX IF NOT EXISTS "compute_leases_resource_idx"
  ON "compute_leases" ("user_id", "resource_id") WHERE "state" = 'active';
