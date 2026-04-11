-- Add semantic_slug to profiles for cross-workspace identity.
--
-- semantic_slug is a stable semantic tag that identifies what a profile
-- *represents* (e.g., "task", "project", "person") independently of its
-- DB primary key or workspace ownership.
--
-- Rules:
--   - Two workspace-scoped profiles with the same semantic_slug in different
--     workspaces are treated as the same concept for cross-workspace queries.
--   - Standard concepts (task, project, person, note, event, company) are
--     auto-assigned by the provisioning layer if not explicitly set.
--   - NULL means "private concept, no cross-workspace semantics".

ALTER TABLE profiles ADD COLUMN semantic_slug text;

CREATE INDEX profiles_semantic_slug_idx
  ON profiles (semantic_slug)
  WHERE semantic_slug IS NOT NULL;
