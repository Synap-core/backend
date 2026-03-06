-- Migration 0007: Create widget_definitions table
--
-- Stores widget type definitions for the dynamic bento widget registry.
-- Built-in widget types (renderer_type = 'builtin') are seeded at startup
-- with workspace_id = NULL (system-wide scope).
--
-- Custom widgets (renderer_type = 'iframe') can be created per-workspace
-- by AI agents (via generate_widget tool) or by workspace owners.
--
-- The config_schema column (JSONSchema) drives:
--   - Intelligence Service config generation and validation
--   - Auto-generated settings forms in the frontend

CREATE TABLE IF NOT EXISTS widget_definitions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  type_key        text        NOT NULL,
  workspace_id    uuid        REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Display
  name            text        NOT NULL,
  description     text,
  icon            text,
  category        text,

  -- Renderer
  renderer_type   text        NOT NULL DEFAULT 'builtin'
                    CHECK (renderer_type IN ('builtin', 'iframe')),
  renderer_source text,       -- Full HTML doc for iframe; NULL for builtins

  -- Config
  config_schema   jsonb       NOT NULL DEFAULT '{}',
  default_config  jsonb                DEFAULT '{}',
  default_size    jsonb       NOT NULL DEFAULT '{"w":6,"h":4}',
  min_size        jsonb,

  -- Lifecycle
  is_active       boolean     NOT NULL DEFAULT true,
  version         text                 DEFAULT '1.0.0',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- typeKey is unique within workspace scope (NULL = system-wide)
  UNIQUE NULLS NOT DISTINCT (type_key, workspace_id)
);

CREATE INDEX IF NOT EXISTS widget_def_workspace_id_idx ON widget_definitions (workspace_id);
CREATE INDEX IF NOT EXISTS widget_def_is_active_idx    ON widget_definitions (is_active);
