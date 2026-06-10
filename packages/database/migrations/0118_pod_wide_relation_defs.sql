-- 0118: Make relation_defs pod-wide
-- relation_defs.workspace_id becomes nullable so relation types can be shared
-- across the entire pod. Workspace-scoped defs still have a workspace_id set;
-- pod-wide defs have workspace_id = NULL.
-- The unique constraint is replaced: pod-wide defs are unique by slug alone;
-- workspace-scoped defs remain unique by (slug, workspace_id).

-- 1. Drop the old unique constraint
ALTER TABLE "relation_defs" DROP CONSTRAINT IF EXISTS "relation_defs_slug_workspace_unique";

-- 2. Make workspace_id nullable
ALTER TABLE "relation_defs" ALTER COLUMN "workspace_id" DROP NOT NULL;

-- 3. Create partial unique indexes:
--    Pod-wide: unique slug where workspace_id IS NULL
--    Workspace-scoped: unique (slug, workspace_id) where workspace_id IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS "relation_defs_slug_pod_unique"
  ON "relation_defs" ("slug")
  WHERE "workspace_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "relation_defs_slug_workspace_unique"
  ON "relation_defs" ("slug", "workspace_id")
  WHERE "workspace_id" IS NOT NULL;
