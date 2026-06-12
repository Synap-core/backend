-- 0122_notifications_unread_partial_idx.sql
-- Partial index for the frequently-polled unread-count badge query.
--
-- notifCenter.unreadCount runs COUNT(*) WHERE (workspace_id, user_id, status='unread')
-- on every bell-badge poll. The existing notifs_user_workspace_status_idx covers
-- the columns but indexes ALL statuses (read/dismissed/actioned dominate over time).
-- A partial index on just the unread rows is much smaller (only the live unread
-- set), stays hot in cache, and lets the count be served as an index-only scan.
CREATE INDEX IF NOT EXISTS "notifs_unread_user_workspace_idx"
  ON "notifications" ("user_id", "workspace_id")
  WHERE "status" = 'unread';
