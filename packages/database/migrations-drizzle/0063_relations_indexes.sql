-- Add indexes to the relations table for efficient graph traversal.
-- Without these, getRelated() / getConnections() / traverseGraph() do full
-- table scans on every call. At even modest scale (10k relations) this becomes
-- a bottleneck.

-- Primary traversal pattern: "give me all relations where this entity is the source"
CREATE INDEX IF NOT EXISTS "relations_source_workspace_idx"
  ON "relations" ("source_entity_id", "workspace_id");

-- Primary traversal pattern: "give me all relations where this entity is the target"
CREATE INDEX IF NOT EXISTS "relations_target_workspace_idx"
  ON "relations" ("target_entity_id", "workspace_id");

-- Relation type lookups (filter by type within a workspace)
CREATE INDEX IF NOT EXISTS "relations_type_workspace_idx"
  ON "relations" ("type", "workspace_id");

-- User-scoped relation listings
CREATE INDEX IF NOT EXISTS "relations_user_workspace_idx"
  ON "relations" ("user_id", "workspace_id");
