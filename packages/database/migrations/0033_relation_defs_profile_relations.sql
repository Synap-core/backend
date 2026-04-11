-- 0033_relation_defs_profile_relations.sql
--
-- Schema-level relation definitions and profile-to-profile linking.
-- Follows the same pattern as property_defs + profile_properties.

-- Catalog of relation types per workspace (e.g. "works_at", "manages")
CREATE TABLE IF NOT EXISTS relation_defs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  description     TEXT,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  ui_hints        JSONB NOT NULL DEFAULT '{}',
  is_directional  BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(slug, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_relation_defs_workspace_id ON relation_defs(workspace_id);

-- Junction table: which profiles can connect via which relation type
CREATE TABLE IF NOT EXISTS profile_relations (
  source_profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  relation_def_id   UUID NOT NULL REFERENCES relation_defs(id) ON DELETE CASCADE,
  display_order     INTEGER NOT NULL DEFAULT 0,
  metadata          JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (source_profile_id, target_profile_id, relation_def_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_relations_source ON profile_relations(source_profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_relations_target ON profile_relations(target_profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_relations_def ON profile_relations(relation_def_id);
