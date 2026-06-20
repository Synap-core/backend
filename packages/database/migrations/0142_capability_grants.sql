-- 0142_capability_grants.sql
-- Generalize `vault_grants` (secret-only) → capability grants (grant the CAPABILITY).
--
-- Wave 1 of the capability-permission path (G1). The enforcement core of
-- vault_grants (scope / expiry / max_uses / use_count / revoked_at / granted_to
-- / workspace_id) was already capability-agnostic; the ONLY secret-specific
-- coupling was the `secret_id` FK (+ ON DELETE CASCADE). This migration makes
-- the subject POLYMORPHIC:
--   - add `grantable_type` enum (secret|tool|skill|command) + `grantable_id` text
--   - add `exec_mode` enum (auto|propose|dry-run) — the governance axis
--   - backfill existing rows as grantable_type='secret', grantable_id=secret_id
--   - rebuild the hot-path index onto (grantable_type, grantable_id, revoked_at)
--
-- Rename-in-place (table keeps the name `vault_grants`) per G1: fewer issuance +
-- redemption sites to touch, existing rows preserved.
--
-- LOWER-RISK CHOICE: keep `secret_id` (made nullable, FK + NOT NULL dropped)
-- rather than DROP it. Dropping a column is irreversible if a downstream reader
-- (analytics/audit export) still consults it; the FK cascade is the only thing
-- that genuinely cannot generalize to a polymorphic id, so we drop ONLY the FK
-- constraint and the NOT NULL, leaving the historical value in place. Orphan
-- cleanup is handled lazily at resolve time (a grant whose grantable no longer
-- resolves is already dead), so no expiry/cleanup worker is required.

-- New enums (guarded: Postgres has no CREATE TYPE IF NOT EXISTS).
DO $$ BEGIN
  CREATE TYPE grantable_type AS ENUM ('secret', 'tool', 'skill', 'command');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE grant_exec_mode AS ENUM ('auto', 'propose', 'dry-run');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- New columns (nullable at first so the backfill can run on existing rows).
ALTER TABLE vault_grants ADD COLUMN IF NOT EXISTS grantable_type grantable_type;
ALTER TABLE vault_grants ADD COLUMN IF NOT EXISTS grantable_id text;
ALTER TABLE vault_grants ADD COLUMN IF NOT EXISTS exec_mode grant_exec_mode NOT NULL DEFAULT 'auto';

-- Backfill existing rows: every legacy grant is a secret grant.
-- Guarded on secret_id existing so this is safe on a fresh pod where the column
-- may already be absent / on a re-run.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vault_grants' AND column_name = 'secret_id'
  ) THEN
    UPDATE vault_grants
       SET grantable_type = 'secret',
           grantable_id   = secret_id::text
     WHERE grantable_type IS NULL
        OR grantable_id IS NULL;
  END IF;
END $$;

-- Drop the secret-specific FK + NOT NULL (a polymorphic grantable_id can't FK
-- one table). Keep the secret_id column data for now. Constraint name is the
-- Postgres default for a column-level REFERENCES.
ALTER TABLE vault_grants DROP CONSTRAINT IF EXISTS vault_grants_secret_id_fkey;
ALTER TABLE vault_grants ALTER COLUMN secret_id DROP NOT NULL;

-- After the backfill, make the polymorphic subject columns NOT NULL (defensive:
-- only enforce once every row has a value — the backfill above guarantees it).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault_grants WHERE grantable_type IS NULL OR grantable_id IS NULL
  ) THEN
    ALTER TABLE vault_grants ALTER COLUMN grantable_type SET NOT NULL;
    ALTER TABLE vault_grants ALTER COLUMN grantable_id SET NOT NULL;
  END IF;
END $$;

-- Rebuild the hot-path index: the redemption lookup keys on
-- (grantable_type, grantable_id, revoked_at) now, not (secret_id, revoked_at).
-- Keep the SAME index name so the schema (which declares it as
-- idx_vault_grants_secret_active) stays coherent.
DROP INDEX IF EXISTS idx_vault_grants_secret_active;
CREATE INDEX IF NOT EXISTS idx_vault_grants_secret_active
  ON vault_grants(grantable_type, grantable_id, revoked_at);

-- The old per-secret index is no longer used by any query (secret_id is now a
-- legacy/audit column). Drop it to avoid a dead index on writes.
DROP INDEX IF EXISTS idx_vault_grants_secret_id;
