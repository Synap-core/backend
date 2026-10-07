-- 0313: apps.agent_user_id — the agent user an Application acts as.
--
-- An app's key is held by this agent and linked to the owner, so its writes
-- run the agent governance ladder. `notAnAppAgent` (@synap/database) reads
-- this column to keep app agents out of agent rosters. Nullable: set when the
-- app's first key is issued. One agent per app (unique, partial). Idempotent.

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "agent_user_id" text
  REFERENCES "users"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "apps_agent_user_unique"
  ON "apps" ("agent_user_id") WHERE "agent_user_id" IS NOT NULL;
