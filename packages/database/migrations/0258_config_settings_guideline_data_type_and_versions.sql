-- 0258_config_settings_guideline_data_type_and_versions.sql
--
-- Two additions to the guideline store (`config_settings key='guideline'`,
-- 0235 / 0253), both founder decisions of 2026-09-13 (intake room plan §3.3):
--
-- 1. THE DATA-TYPE RUNGS. A guideline can now scope to what is being
--    STRUCTURED, not only to where a message came from:
--      sourceKind — the kind of INPUT (`text | url | image | file | audio`, or
--                   `import:<IMPORT_SOURCE_VALUES>`); closed at the write door.
--      entityKind — the kind of OUTPUT (a profile slug, e.g. `person`).
--    SPECIFICITY lives in application code (`SCOPE_ORDER`,
--    utils/config-settings.ts), never in this enum's declaration order:
--    default < workKind < sourceKind < entityKind < channelType < bridge <
--    channel < shape.
--    ADDITIVE AND INERT: no existing row carries either value, and a resolver
--    caller that passes no `sourceKind` / `entityKinds` context can never match
--    one — so governance's origin-trust read (rung 2.55) is unchanged.
--
-- 2. VERSIONS. An "edit" is a SUPERSEDE: a new row with `version = old + 1`
--    and `supersedes_id = old.id`, the old row revoked in the same
--    transaction. History is the `supersedes_id` chain; nothing is updated in
--    place. The partial UNIQUE index makes a row supersedable at most once, so
--    two concurrent edits of the same version cannot both land (the second
--    fails instead of forking the lineage). Existing rows are version 1.
--
-- TRANSACTION NOTE (same as 0253): `scripts/migrate.ts` wraps each migration in
-- `sql.begin()`. `ALTER TYPE … ADD VALUE` is legal in a transaction on PG12+
-- provided the new value is not USED in that same transaction — nothing here
-- uses it. `IF NOT EXISTS` everywhere makes a re-run a no-op.

ALTER TYPE config_scope_kind ADD VALUE IF NOT EXISTS 'sourceKind';
ALTER TYPE config_scope_kind ADD VALUE IF NOT EXISTS 'entityKind';

ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
ALTER TABLE "config_settings" ADD COLUMN IF NOT EXISTS "supersedes_id" uuid;

CREATE UNIQUE INDEX IF NOT EXISTS "config_settings_supersedes_uq"
  ON "config_settings" ("supersedes_id")
  WHERE "supersedes_id" IS NOT NULL;
