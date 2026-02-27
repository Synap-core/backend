-- Migration 0034: Add agentUserId and expiresAt columns to proposals table

ALTER TABLE "proposals"
  ADD COLUMN IF NOT EXISTS "agent_user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "idx_proposals_agent_user_id" ON "proposals"("agent_user_id");
