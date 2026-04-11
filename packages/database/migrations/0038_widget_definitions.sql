-- Dynamic Widget Registry — widget definition catalog
CREATE TABLE IF NOT EXISTS widget_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type_key TEXT NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  category TEXT DEFAULT 'core',
  renderer_type TEXT NOT NULL DEFAULT 'builtin',
  renderer_source TEXT,
  config_schema JSONB NOT NULL DEFAULT '{}',
  default_config JSONB DEFAULT '{}',
  default_size JSONB NOT NULL DEFAULT '{"w":6,"h":4}',
  min_size JSONB,
  is_active BOOLEAN NOT NULL DEFAULT true,
  version TEXT DEFAULT '1.0.0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NULLS NOT DISTINCT: treats (type_key, NULL) as equal so built-in seed is idempotent
CREATE UNIQUE INDEX IF NOT EXISTS widget_def_type_key_workspace_uniq
  ON widget_definitions(type_key, workspace_id) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS widget_def_workspace_id_idx ON widget_definitions(workspace_id);
CREATE INDEX IF NOT EXISTS widget_def_is_active_idx ON widget_definitions(is_active);
CREATE INDEX IF NOT EXISTS widget_def_category_idx ON widget_definitions(category);
