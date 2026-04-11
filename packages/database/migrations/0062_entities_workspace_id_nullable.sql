-- Make entities.workspace_id nullable for pod-scoped entities
-- Pod-wide profiles (note, task, project, event, person, etc.) create entities
-- with workspace_id = NULL, visible across all workspaces.
-- The Drizzle schema already declares this column as nullable (uuid("workspace_id"))
-- but the original table creation had NOT NULL. This migration aligns the DB.

ALTER TABLE "entities" ALTER COLUMN "workspace_id" DROP NOT NULL;
