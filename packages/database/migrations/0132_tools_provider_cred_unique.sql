-- Race-safe materialization of Nango provider connections into `tools` rows.
-- ONE pod-wide tool row per provider (credentialRef = nango://{provider},
-- workspace_id IS NULL). This partial unique index lets connectors.syncToolRows
-- use ON CONFLICT DO NOTHING so concurrent syncs (mount + window-focus, or two
-- users connecting the same provider) cannot create duplicate provider rows.
--
-- Scoped to nango:// + workspace_id IS NULL so it CANNOT collide with builtin or
-- workspace-scoped tools, which legitimately have NULL credential_ref.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_provider_cred
  ON tools (credential_ref)
  WHERE credential_ref LIKE 'nango://%' AND workspace_id IS NULL;
