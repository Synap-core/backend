-- 0236_governance_ceilings.sql
--
-- governance_ceilings — the store for NUMERIC governance limits (as opposed to
-- governance_rules, which stores auto/propose VERDICTS). First slice ships ONE
-- axis: `daily_write_count` — a per-agent (or pod-wide) cap on how many writes
-- an agent may AUTO-EXECUTE per UTC day before further would-be-auto writes are
-- downgraded to a reviewable proposal (rung 2.56, tighten-only).
--
-- SCOPING MIRRORS governance_rules EXACTLY (same principal/scope enums, same
-- (principal, scope) specificity ranking done in application code): a limit can
-- target a specific agent or "any", pod-wide or one workspace. `verdict` has no
-- analog here — the value is a numeric `limit_value`.
--
-- NO SQL DEFAULT on `limit_value`: the ONE source of the fallback default is the
-- TS constant `DEFAULT_DAILY_WRITE_CEILING` (@synap/governance-policy), consulted
-- by the resolver when NO row matches (mirroring how governance_rules falls
-- through to the DEFAULT_AUTO_APPROVE code floor). A stored row always sets its
-- own limit. Additive, tighten-only: a ceiling can only ever downgrade a
-- would-be-auto write to `propose`, never widen or deny.

DO $$ BEGIN
  CREATE TYPE governance_ceiling_axis AS ENUM ('daily_write_count');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- governance_principal / governance_scope already exist (created by 0215); the
-- guarded CREATE TYPE below makes this migration self-contained if replayed on a
-- DB that somehow lacks them.
DO $$ BEGIN
  CREATE TYPE governance_principal AS ENUM ('agent', 'any');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE governance_scope AS ENUM ('workspace', 'pod');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "governance_ceilings" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "axis"                governance_ceiling_axis NOT NULL,

  "principal_kind"      governance_principal NOT NULL,
  "agent_user_id"       text,

  "scope_kind"          governance_scope NOT NULL,
  "workspace_id"        uuid,

  -- The numeric limit for this axis (e.g. max writes/UTC-day). NOT NULL, no SQL
  -- default — see the header note: the fallback default lives ONLY in TS.
  "limit_value"         integer NOT NULL,

  "source_proposal_id"  uuid,

  "created_by"          text NOT NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "revoked_at"          timestamptz,
  "expires_at"          timestamptz
);

-- Idempotent guard for pre-existing tables (mirrors repo convention).
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "axis" governance_ceiling_axis;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "principal_kind" governance_principal;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "agent_user_id" text;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "scope_kind" governance_scope;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "limit_value" integer;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "source_proposal_id" uuid;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;
ALTER TABLE "governance_ceilings" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

-- Resolver's primary lookup: active ceilings for an (axis, scope, workspace,
-- principal) tuple; the resolver ranks matches by specificity in application code.
CREATE INDEX IF NOT EXISTS "governance_ceilings_axis_scope_principal_idx"
  ON "governance_ceilings" ("axis", "scope_kind", "workspace_id", "principal_kind", "agent_user_id")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "governance_ceilings_agent_active_idx"
  ON "governance_ceilings" ("agent_user_id")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "governance_ceilings_source_proposal_idx"
  ON "governance_ceilings" ("source_proposal_id");
