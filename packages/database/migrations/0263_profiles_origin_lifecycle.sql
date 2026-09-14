-- 0263_profiles_origin_lifecycle.sql
--
-- Profiles gain PROVENANCE (`origin`), an optional OWNER reference and a
-- LIFECYCLE that is separate from `is_active` (founder decision P2, 2026-09-14).
--
-- Before this a kind carried no answer to "who brought this into the pod?".
-- `is_active` is the soft-delete tombstone, not a state, so a dogfood probe kind,
-- a template kind nobody uses and a core kind were indistinguishable to every
-- listing and to any hygiene pass.
--
--   origin     core | template | authored | agent | probe | unknown
--   lifecycle  experimental | active | deprecated
--   owner      owner_kind + owner_id (both or neither)
--
-- OWNER AS TWO COLUMNS, NOT ONE jsonb: the consumers query BY owner ("every row
-- this package installed", "the row this proposal minted"), a CHECK can pin the
-- vocabulary and the both-or-neither shape at the DB, and there is no drizzle
-- jsonb `.set()` trap for writers.
--
-- BACKFILL IS HONEST, not a guess. A marker may only assert what was checked:
--   core     scope = 'system' (every platform seed writes scope 'system').
--   agent    an AGENT-attributed `profile` create proposal whose target_id IS
--            the row id: an auto-approve RECEIPT (the gate pre-mints the id it
--            creates with) or a pending proposal the async materializer applied
--            (it creates with that same pre-minted id). ROW IDENTITY ONLY.
--            A pending proposal approved through the sync `profile/create`
--            executor is NOT backfilled: that executor mints a fresh id and
--            records no link to the row, so the only possible join is slug +
--            workspace + order — and that also claims any LATER human or
--            template row reusing the slug (a retired agent kind re-seeded by a
--            template). Those rows stay `unknown`; from 0263 on the executor
--            stamps origin + owner at write time.
--   template NOT backfilled. A workspace's settings name the package/template
--            (packageSlug / templateId / templateName), but the pod stores no
--            copy of that template's definition, so "this slug came from that
--            template" cannot be verified in SQL. Left `unknown`.
--   authored NOT backfilled. A human create and a template-engine create leave
--            the same row; nothing distinguishes them after the fact.
-- Everything else stays `unknown`.
--
-- IDEMPOTENT: every column/constraint is IF NOT EXISTS / duplicate-guarded, and
-- every backfill UPDATE only touches rows still at origin = 'unknown', so a
-- re-run changes nothing.

ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'unknown';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "lifecycle" text NOT NULL DEFAULT 'active';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "owner_kind" text;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "owner_id" text;

DO $$ BEGIN
  ALTER TABLE "profiles" ADD CONSTRAINT "profiles_origin_check"
    CHECK (origin IN ('core', 'template', 'authored', 'agent', 'probe', 'unknown'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "profiles" ADD CONSTRAINT "profiles_lifecycle_check"
    CHECK (lifecycle IN ('experimental', 'active', 'deprecated'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "profiles" ADD CONSTRAINT "profiles_owner_check"
    CHECK (
      (owner_kind IS NULL AND owner_id IS NULL) OR
      (owner_kind IN ('package', 'workspace', 'proposal', 'agent', 'user')
        AND owner_id IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ── Backfill: core ──────────────────────────────────────────────────────────
UPDATE "profiles"
SET "origin" = 'core'
WHERE "origin" = 'unknown' AND "scope" = 'system';

-- ── Backfill: agent, by ROW IDENTITY (target_id = the row id) ──────────────
-- Only a proposal that authorized the write (auto-approved receipt or approved
-- pending) can have produced the row. No slug join: see the header.
UPDATE "profiles" p
SET "origin" = 'agent',
    "owner_kind" = 'proposal',
    "owner_id" = r.id::text
FROM (
  SELECT DISTINCT ON (target_id) id, target_id
  FROM "proposals"
  WHERE target_type = 'profile'
    AND proposal_type IN ('profile.create', 'create')
    AND status IN ('auto_approved', 'approved')
    AND agent_user_id IS NOT NULL
  ORDER BY target_id, created_at ASC
) r
WHERE p."origin" = 'unknown'
  AND r.target_id = p.id::text;
