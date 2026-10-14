-- 0329 — an agent can be ASSIGNED work and PAUSED (agent routing W1b)
--
-- Assignment is a link, not a column: participant(agent) --assigned_to-->
-- playbook | profile | project | workspace. THE route (`route()`) reads it as
-- the rung after the roster: the most specific target wins
-- (playbook > profile > project > workspace — founder decision 2026-10-14).
-- One agent per target: a person re-assigning a target replaces its agent, so
-- the pick can never be ambiguous. Written only by a person
-- (`agentUsers.setAssignment`).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_links_assigned_to_one_per_target"
  ON "links" ("to_type", "to_id")
  WHERE "link_type" = 'assigned_to';

-- Pause: a paused agent is skipped by every rung of the route that picks for
-- the person (roster, assignment, the single one); naming it is refused with
-- the reason. Pausing never revokes its keys. NULL = not paused.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_paused_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_paused_by" text;
