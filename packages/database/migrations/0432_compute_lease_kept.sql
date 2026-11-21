-- 0432 — a new pod's server is KEPT once it registers (plan a640c5bb B1,
-- ticket 6ab89fd0; founder, 18 Nov 2026: "defaults").
--
-- An agent starts a person's new pod server through any provision_compute
-- verb; the server's startup script carries the pod registration code the
-- Control Plane minted. The start's lease records that code's sha256 (the
-- digest the Control Plane stores too, never the code), and the TTL sweeper
-- asks the Control Plane whether it registered: registered = the lease ends
-- `kept` and the server is never destroyed at its TTL. A start with no code
-- is unchanged.

ALTER TABLE "compute_leases"
  ADD COLUMN IF NOT EXISTS "registration_code_hash" text;

ALTER TABLE "compute_leases"
  DROP CONSTRAINT IF EXISTS "compute_leases_state_check";
ALTER TABLE "compute_leases"
  ADD CONSTRAINT "compute_leases_state_check"
    CHECK ("state" IN ('starting', 'active', 'released', 'not_started', 'unknown', 'kept'));
