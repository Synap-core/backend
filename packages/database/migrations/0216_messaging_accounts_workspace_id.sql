-- 0216_messaging_accounts_workspace_id.sql
--
-- Pin a connected messaging account to a workspace (webhook workspace-resolution fix).
--
-- The inbound `/messaging` webhook resolved the target workspace via
-- `workspaces.findFirst({ where: ownerId })` with NO orderBy — arbitrary for a
-- multi-workspace owner. Root cause: `messaging_accounts` had no workspace pin.
--
-- This adds a NULLABLE `workspace_id`:
--   - legacy rows + accounts synced by the `account.created` webhook stay NULL
--     (that path has no workspace context) → webhook keeps its owner-first
--     fallback for them (back-compat preserved);
--   - `runLinkedInBackfill` upserts the row WITH the workspace it recorded into,
--     so the webhook can pin later inbound messages to the correct workspace.
--
-- Additive + nullable → safe, non-breaking. No index needed: the webhook already
-- looks the row up by (external_id, provider) and reads workspace_id off it.

ALTER TABLE "messaging_accounts" ADD COLUMN IF NOT EXISTS "workspace_id" text;
