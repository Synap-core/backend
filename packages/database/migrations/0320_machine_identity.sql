-- 0320: a computer gets its own governed principal (MACHINE-IDENTITY-PLAN W1,
-- founder decisions 2026-10-11).
--
-- 1. `users.host_user_id` — the COMPUTER an agent runs on. A computer is an
--    agent user with `agent_type = 'machine'`; "Claude Code on devbox" is a
--    distinct agent user whose host is devbox. NULL = no computer, which is
--    every agent before this migration: they stay exactly as they are (no data
--    is moved). Deliberately NOT `parent_agent_id` (orchestrator → persona, and
--    it hands the parent read access to the child's configs).
--
-- 2. The one-agent-per-(person, type) index of 0228 becomes one agent per
--    (person, type, computer). `COALESCE(host_user_id, '')` keeps every
--    existing row's key identical (all NULL → ''), so the rebuild cannot
--    collide on existing data. Computers themselves are excluded: a person
--    has several.
--
-- 3. The `class` governance principal — "for all computers" — ranked between
--    a specific agent and `any` (agent=2 > class=1 > any=0, application code).
--    `principal_class` names the class (`machine`). Same on governance_ceilings.
--
-- TRANSACTION NOTE: the migrator runs each file inside `sql.begin()`.
-- `ALTER TYPE … ADD VALUE` is legal in a transaction on PG12+ provided the new
-- value is not USED in the same transaction (precedent 0253/0258/0266). The
-- CHECK constraints below compare `principal_kind::text`, so they never
-- resolve the new enum literal.

-- ── 1. host link ────────────────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "host_user_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_host_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_host_user_id_users_id_fk"
      FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- "every agent this computer hosts" (revoke cascade, clip, roster).
CREATE INDEX IF NOT EXISTS "idx_users_host_user_id"
  ON "users" ("host_user_id")
  WHERE "host_user_id" IS NOT NULL;

-- ── 2. one agent per (person, type, computer) ──────────────────────────────
DROP INDEX IF EXISTS idx_users_service_agent_creator_type_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_service_agent_creator_type_host_unique
  ON users (created_by_user_id, agent_type, COALESCE(host_user_id, ''))
  WHERE user_type = 'agent'
    AND agent_template IS NULL
    AND COALESCE(is_personal_agent, false) = false
    AND created_by_user_id IS NOT NULL
    AND agent_type IS NOT NULL
    AND agent_type <> 'machine';

-- ── 3. the `class` principal ───────────────────────────────────────────────
ALTER TYPE governance_principal ADD VALUE IF NOT EXISTS 'class';

ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "principal_class" text;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "principal_class" text;

-- A class row names its class; nothing else carries one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'governance_rules_principal_class_check'
  ) THEN
    ALTER TABLE "governance_rules" ADD CONSTRAINT "governance_rules_principal_class_check"
      CHECK (("principal_kind"::text = 'class') = ("principal_class" IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'governance_ceilings_principal_class_check'
  ) THEN
    ALTER TABLE "governance_ceilings" ADD CONSTRAINT "governance_ceilings_principal_class_check"
      CHECK (("principal_kind"::text = 'class') = ("principal_class" IS NOT NULL));
  END IF;
END $$;
