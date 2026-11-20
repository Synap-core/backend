-- 0442 — the actor column on automations and playbooks (consolidation W1,
-- founder decision: a person owns everything, an agent is only the actor).
--
-- Both tables held ONE "who" column (`created_by`), so an agent that authored
-- an automation or a playbook landed as its OWNER: its runs resolved the runner
-- roster, the run session, the AI principal and RBAC against the agent
-- (tickets 01b5b0b3, da1199bb). `created_by` keeps meaning the owner (the
-- person); `agent_user_id` records the agent that authored the row. The
-- governance ladder reads the actor; everything else reads the owner.
--
-- Columns only, nullable (a person's own row has no agent). The rows an agent
-- owns today move in 0443.

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
