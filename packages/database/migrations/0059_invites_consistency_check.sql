-- Migration: enforce invite type/workspaceId consistency
-- workspace invites must have workspace_id set; pod invites must not.
ALTER TABLE "invites"
  ADD CONSTRAINT "invites_workspace_consistency" CHECK (
    (type = 'workspace' AND workspace_id IS NOT NULL) OR
    (type = 'pod'       AND workspace_id IS NULL)
  );
