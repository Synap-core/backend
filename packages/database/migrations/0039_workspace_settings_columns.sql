-- 0039_workspace_settings_columns.sql
--
-- Promote hot workspaces.settings keys (queried in WHERE/predicate paths) out of
-- the JSONB blob into real, indexed columns. settings JSONB is KEPT and
-- dual-written during the transition; query predicates move to the columns.
--   system_slug              ← settings->>'systemSlug'  (resolves pod-admin/system workspaces; hot read)
--   package_slug             ← settings->>'packageSlug'
--   provisioning_proposal_id ← settings->>'proposalId'  (workspace-provisioning idempotency key)
--   provisioning_status      ← settings->>'provisioningStatus'

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS system_slug              text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS package_slug             text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS provisioning_proposal_id text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS provisioning_status      text;

UPDATE workspaces SET
  system_slug              = settings->>'systemSlug',
  package_slug             = settings->>'packageSlug',
  provisioning_proposal_id = settings->>'proposalId',
  provisioning_status      = settings->>'provisioningStatus';

CREATE INDEX IF NOT EXISTS idx_workspaces_system_slug
  ON workspaces (system_slug) WHERE system_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspaces_provisioning_proposal_id
  ON workspaces (provisioning_proposal_id) WHERE provisioning_proposal_id IS NOT NULL;
