-- Allow pod-wide scope for governance/runtime tables.
ALTER TABLE proposals
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE notifications
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE notification_preferences
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE automations
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE automation_runs
ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE channel_context_items
ALTER COLUMN workspace_id DROP NOT NULL;
