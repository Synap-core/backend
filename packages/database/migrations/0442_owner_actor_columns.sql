-- 0442 — the actor column on automations and playbooks: a person owns the row
-- (`created_by`), the agent that authored it is `agent_user_id`. The governance
-- ladder reads the actor; RBAC, the run session, the runner roster and the AI
-- principal read the owner. Nullable: a person's own row has no agent.
-- ON DELETE SET NULL: the agent-delete doors pause its automations first
-- (`pauseAutomationsOfAgents`). Rows an agent owns today move in 0443.

ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "agent_user_id" text;
ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "agent_user_id" text;

DO $$ BEGIN
  ALTER TABLE "automations"
    ADD CONSTRAINT "automations_agent_user_id_fkey"
    FOREIGN KEY ("agent_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "playbooks"
    ADD CONSTRAINT "playbooks_agent_user_id_fkey"
    FOREIGN KEY ("agent_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "automations_agent_user_id_idx"
  ON "automations" ("agent_user_id");
CREATE INDEX IF NOT EXISTS "idx_playbooks_agent_user_id"
  ON "playbooks" ("agent_user_id");
