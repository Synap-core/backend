/**
 * TEST SUPPORT — the tables and columns `foldAnchorsIntoAttachments` (Surfaces
 * P3, `p3.surfaces.*`) reads and writes, for the conversion PGlite harnesses
 * that hand-write their schema and run those ops. Additive and idempotent, like
 * `LIFECYCLE_PROJECTION_TEST_SCHEMA`: append it; a table or column the harness
 * already has is left as it is.
 */
export const ATTACHMENT_FOLD_TEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE entities ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS system_data jsonb NOT NULL DEFAULT '{}';
ALTER TABLE entities ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS views (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE IF NOT EXISTS playbooks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid);
CREATE TABLE IF NOT EXISTS renderer_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind text NOT NULL DEFAULT 'pod',
  workspace_id uuid,
  subject_kind text NOT NULL,
  subject_id text,
  content_kind text NOT NULL DEFAULT 'entity-detail',
  surface text NOT NULL DEFAULT 'app',
  ref jsonb NOT NULL,
  created_by text NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS relations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE relations ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'entity';
ALTER TABLE relations ADD COLUMN IF NOT EXISTS source_cell_id uuid;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS target_entity_id uuid;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
CREATE TABLE IF NOT EXISTS cell_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id text NOT NULL,
  cell_type text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  name text,
  created_by_kind text NOT NULL DEFAULT 'user',
  trust_level text NOT NULL DEFAULT 'trusted'
);
CREATE TABLE IF NOT EXISTS links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid,
  from_type text NOT NULL,
  from_id text NOT NULL,
  to_type text NOT NULL,
  to_id text NOT NULL,
  link_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique_edge
  ON links (from_type, from_id, to_type, to_id, link_type);
`;
