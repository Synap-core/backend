-- Add workspace_id to webhook_subscriptions for workspace-scoped outbound webhooks
ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS workspace_id uuid
  REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS webhook_subscriptions_workspace_id_idx
  ON webhook_subscriptions(workspace_id);
