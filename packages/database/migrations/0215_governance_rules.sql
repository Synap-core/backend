-- 0215_governance_rules.sql
--
-- governance_rules — the ONE store for agent/pod auto-approve policy
-- (Governance Convergence Plan, Phase A). Additive, no reads wired yet: the
-- resolver + engine rung 2.8 land in a separate wave. Zero behavior change.
--
-- A rule scopes an auto-approve/propose verdict to a principal (a specific
-- agent, or 'any'), a scope (one workspace, or pod-wide), and a target
-- (an action pattern, an entity profile, or a capability id). `verdict` is
-- NEVER 'deny' — denial stays a CBAC/floor concern, never a user-authored rule.

DO $$ BEGIN
  CREATE TYPE governance_principal AS ENUM ('agent', 'any');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE governance_scope AS ENUM ('workspace', 'pod');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE governance_target AS ENUM ('action', 'profile', 'capability');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE governance_verdict AS ENUM ('auto', 'propose');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "governance_rules" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "principal_kind"      governance_principal NOT NULL,
  "agent_user_id"       text,

  "scope_kind"          governance_scope NOT NULL,
  "workspace_id"        uuid,

  "target_kind"         governance_target NOT NULL,
  "target_pattern"      text NOT NULL,
  "target_profile"      text,

  "verdict"             governance_verdict NOT NULL,

  "source_proposal_id"  uuid,

  "created_by"          text NOT NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "revoked_at"          timestamptz,
  "expires_at"          timestamptz
);

-- Idempotent guard for pre-existing tables (mirrors repo convention).
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "principal_kind" governance_principal;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "agent_user_id" text;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "scope_kind" governance_scope;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "target_kind" governance_target;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "target_pattern" text;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "target_profile" text;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "verdict" governance_verdict;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "source_proposal_id" uuid;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;
ALTER TABLE "governance_rules" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

-- Resolver's primary lookup: active rules for a (scope, workspace, principal)
-- tuple; the resolver ranks matches by specificity in application code.
CREATE INDEX IF NOT EXISTS "governance_rules_scope_principal_idx"
  ON "governance_rules" ("scope_kind", "workspace_id", "principal_kind", "agent_user_id")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "governance_rules_agent_active_idx"
  ON "governance_rules" ("agent_user_id")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "governance_rules_source_proposal_idx"
  ON "governance_rules" ("source_proposal_id");
