/**
 * TEST SUPPORT — the columns the lifecycle projection reads, for the conversion
 * PGlite harnesses that hand-write their schema.
 *
 * The engine re-projects the lifecycle columns after every op that changed
 * data (`reprojectAfterOp`, engine.ts), so every harness that applies an op
 * needs what `lifecycleProjectionStatements` reads: `profiles.parent_profile_id`,
 * `profile_properties.is_lifecycle`, `property_defs.slug|constraints` and the
 * 0319 `status|status_category` columns on both row tables. Additive and
 * idempotent: append it to a harness schema; a column the harness already has
 * is left as it is.
 */
export const LIFECYCLE_PROJECTION_TEST_SCHEMA = `
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS parent_profile_id uuid;
CREATE TABLE IF NOT EXISTS property_defs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE property_defs ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE property_defs ADD COLUMN IF NOT EXISTS constraints jsonb;
CREATE TABLE IF NOT EXISTS profile_properties (profile_id uuid, property_def_id uuid);
ALTER TABLE profile_properties ADD COLUMN IF NOT EXISTS is_lifecycle boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS entities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS properties jsonb;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS status_category text;
CREATE TABLE IF NOT EXISTS entity_facets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid);
ALTER TABLE entity_facets ADD COLUMN IF NOT EXISTS properties jsonb;
ALTER TABLE entity_facets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE entity_facets ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE entity_facets ADD COLUMN IF NOT EXISTS status_category text;
`;
