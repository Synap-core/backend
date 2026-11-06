-- 0400 — Synap account agents get their own identity (review bf96d410 of the
-- connect wave, lane B; founder decision 4 of 4 Nov 2026: keep /mcp/redeem,
-- harden it).
--
-- 1. `api_keys.origin`: the door that minted the key, written by that door
--    only. 'synap-account' = /mcp/redeem (the Control Plane's MCP connector);
--    NULL = any other door. "Is this the connector's key?" used to be read
--    from the instanceId prefix `mcp:`, which /setup/agent let any caller
--    send. A rotation carries the origin like the rest of the key's identity.
--    Backfill: the keys that reader counted as the connector's, minus the
--    OAuth door's (`oauth:` instance, revoked through its own /revoke): an
--    agent's key whose instanceId starts with `mcp:`, or a `claude-web`
--    agent's key with no instanceId (before W5 the connector's only agent).
--
-- 2. `users.host_seat = 'synap:account'` (SYNAP_ACCOUNT_SEAT,
--    @synap-core/types/agents) on every computer-less agent that holds such a
--    key. The seat is part of the agent's identity (0395's unique index), so a
--    Synap account agent is never the agent /setup/agent finds, and never one
--    a computer adopts. No CLI can send the seat (it has a colon). Keys are
--    untouched: every live key keeps working, held by the same agent.
--    The rebuild cannot collide: no row holds this seat yet, and the rows it
--    moves are already unique on (creator, type, no computer, role).
--
-- Re-runnable: IF NOT EXISTS, and both UPDATEs only touch rows still unset.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "origin" text;

UPDATE "api_keys" k
   SET "origin" = 'synap-account'
  FROM "users" u
 WHERE k."origin" IS NULL
   AND u."id" = k."user_id"
   AND u."user_type" = 'agent'
   AND (
     k."instance_id" LIKE 'mcp:%'
     OR (u."agent_type" = 'claude-web' AND k."instance_id" IS NULL)
   );

UPDATE "users" u
   SET "host_seat" = 'synap:account',
       "updated_at" = now()
 WHERE u."user_type" = 'agent'
   AND u."host_user_id" IS NULL
   AND u."host_seat" IS NULL
   AND COALESCE(u."is_personal_agent", false) = false
   AND u."agent_type" IS NOT NULL
   AND u."agent_type" <> 'machine'
   AND EXISTS (
     SELECT 1 FROM "api_keys" k
      WHERE k."user_id" = u."id"
        AND k."origin" = 'synap-account'
   );
