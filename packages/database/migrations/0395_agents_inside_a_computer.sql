-- 0395: a computer is approved once; the agents inside it are told apart by
-- the OS user they run as (the SEAT) and their JOB (the role). Plan "Computer
-- once, agents inside" rev 3 (pod document 31470fd5, founder-approved
-- 2026-11-03, defaults D1-D9).
--
-- On 2 Nov a second OS user on devbox ran `synap init`; the page pre-selected
-- "Reconnect devbox" by hostname and the approval re-keyed every agent of the
-- computer, a running worker included. A seat alone would merge two workers
-- of one OS user (the CRM worker and the dev worker), so the identity gets
-- both:
--
-- 1. `users.host_seat` — the OS user on the computer the agent runs as.
--    NULL = an agent made before seats (every row today).
-- 2. `users.agent_role` — the job slug ("crm-worker"). NULL = the engine's
--    plain agent ("Claude Code on devbox"). `agent_type` keeps meaning the
--    ENGINE for every reader (launch, service names, SURFACE_AGENT_TYPES).
--
-- 3. 0320's one-agent-per-(person, type, computer) index becomes one agent per
--    (person, type, computer, seat, role). Both new columns are NULL on every
--    existing row, and rows are already unique on the first three, so the
--    rebuild cannot collide on existing data. Same WHERE as 0320.
--
-- 4. The device request carries what a newer CLI sends (every field optional:
--    an older CLI sends none and keeps working):
--    `seat` (the OS user), `seat_id` (sha256 of machine id + seat: the
--    computer key's instance, so an approval replaces only that seat's
--    computer key), `held` (the key ids this seat keeps locally, never a
--    secret: the evidence a reconnect is this seat's own), `requested_rows`
--    (engine + optional job per agent) and `agent_actions` (the person's
--    decision per row: add / reconnect one agent / skip).
--
-- No backfill: nothing is re-keyed or moved. Fresh installs get the columns
-- from 0000_baseline_schema.sql; the index lives here (as 0320's did).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "host_seat" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_role" text;

DROP INDEX IF EXISTS idx_users_service_agent_creator_type_host_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_service_agent_identity_unique
  ON users (
    created_by_user_id,
    agent_type,
    COALESCE(host_user_id, ''),
    COALESCE(host_seat, ''),
    COALESCE(agent_role, '')
  )
  WHERE user_type = 'agent'
    AND agent_template IS NULL
    AND COALESCE(is_personal_agent, false) = false
    AND created_by_user_id IS NOT NULL
    AND agent_type IS NOT NULL
    AND agent_type <> 'machine';

ALTER TABLE "device_auth_requests" ADD COLUMN IF NOT EXISTS "seat" text;
ALTER TABLE "device_auth_requests" ADD COLUMN IF NOT EXISTS "seat_id" text;
ALTER TABLE "device_auth_requests" ADD COLUMN IF NOT EXISTS "held" jsonb;
ALTER TABLE "device_auth_requests" ADD COLUMN IF NOT EXISTS "requested_rows" jsonb;
ALTER TABLE "device_auth_requests" ADD COLUMN IF NOT EXISTS "agent_actions" jsonb;
