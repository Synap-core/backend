-- Migration 0059: Unified Notification System
--
-- Creates:
--   notifications            — persisted notification rows (all types)
--   notification_preferences — per-user, per-workspace delivery preferences
--
-- The notifications table replaces polling against proposals for non-proposal
-- notification types (connector syncs, agent completions, system events).
-- Proposals are still the source of truth — NotificationService creates a
-- notifications row when a proposal is created (wraps, not replaces).

-- ─── notifications ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    text        NOT NULL,
  user_id         text        NOT NULL,

  -- Type (registry key: 'proposal.created', 'connector.sync.complete', etc.)
  type            text        NOT NULL,
  category        text        NOT NULL CHECK (category IN ('governance', 'data', 'ai', 'system', 'inbox')),
  priority        text        NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),

  -- Content
  title           text        NOT NULL,
  body            text        NOT NULL,
  icon            text,

  -- Source traceability
  source_type     text        NOT NULL,
  source_id       text,
  workspace_url   text,

  -- Inline action buttons (JSON array)
  actions         jsonb       NOT NULL DEFAULT '[]',

  -- Grouping
  group_key       text,

  -- State
  status          text        NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'dismissed', 'actioned')),
  read_at         timestamptz,
  expires_at      timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Primary bell query: unread for user in workspace, newest first
CREATE INDEX IF NOT EXISTS notifs_user_workspace_status_idx
  ON notifications (user_id, workspace_id, status, created_at DESC);

-- Group collapsing
CREATE INDEX IF NOT EXISTS notifs_group_key_idx
  ON notifications (group_key, workspace_id)
  WHERE group_key IS NOT NULL;

-- Source lookup (find notification for a proposal)
CREATE INDEX IF NOT EXISTS notifs_source_idx
  ON notifications (source_type, source_id)
  WHERE source_id IS NOT NULL;

-- ─── notification_preferences ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_preferences (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text        NOT NULL,
  workspace_id          text        NOT NULL,

  -- Global
  enabled               boolean     NOT NULL DEFAULT true,
  quiet_hours_enabled   boolean              DEFAULT false,
  quiet_hours_start     text                 DEFAULT '22:00',
  quiet_hours_end       text                 DEFAULT '08:00',
  sound_enabled         boolean              DEFAULT true,

  -- Per-type routing rules: { [notificationType]: "in_app" | "os" | "all" | "mute" }
  routing_rules         jsonb       NOT NULL DEFAULT '{}',

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One prefs row per user per workspace
CREATE UNIQUE INDEX IF NOT EXISTS notif_prefs_user_workspace_idx
  ON notification_preferences (user_id, workspace_id);
