-- 0313: each Application acts as its OWN agent principal (founder decision 2,
-- Connected North Star: "a grant permits, never auto-approves").
--
-- An app's key is minted TO this agent user and linked to the owner
-- (`api_keys.linked_user_id` = owner), exactly like an agent key, so key
-- identity resolves `isAgent: true` and the ONE agent governance ladder
-- (`resolveAgentGovernanceDecision`) decides its writes. The agent is created
-- with the `ask-first` posture (every change to the person's data proposes);
-- the owner widens it per app through ordinary governance rules.
--
-- This column is ALSO the one predicate that keeps app agents out of every
-- agent roster (`notAnAppAgent`, @synap/database): an app agent is shown only
-- as its app.
--
-- Nullable, no default: an app gets its agent when its key is first issued.
-- Keys minted before 0313 (owned by the human) are adopted onto the app's
-- agent the first time they authenticate (`adoptLegacyAppKey`). Idempotent.

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "agent_user_id" text
  REFERENCES "users"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "apps_agent_user_unique"
  ON "apps" ("agent_user_id") WHERE "agent_user_id" IS NOT NULL;
