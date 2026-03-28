/**
 * Notification Types
 *
 * Canonical notification category, priority, and status definitions.
 * These mirror the database schema values but are safe to import in
 * browser/Electron builds (no drizzle/postgres dependency).
 *
 * @see {@link @synap/database/schema notifications.ts} for the DB table definition
 */

// ---------------------------------------------------------------------------
// Notification Categories
// ---------------------------------------------------------------------------

export const NotificationCategory = {
  GOVERNANCE: "governance",
  DATA: "data",
  AI: "ai",
  SYSTEM: "system",
  INBOX: "inbox",
} as const;
export type NotificationCategory =
  (typeof NotificationCategory)[keyof typeof NotificationCategory];

// ---------------------------------------------------------------------------
// Notification Priorities
// ---------------------------------------------------------------------------

export const NotificationPriority = {
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
  URGENT: "urgent",
} as const;
export type NotificationPriority =
  (typeof NotificationPriority)[keyof typeof NotificationPriority];

// ---------------------------------------------------------------------------
// Notification Statuses
// ---------------------------------------------------------------------------

export const NotificationStatus = {
  UNREAD: "unread",
  READ: "read",
  DISMISSED: "dismissed",
  ACTIONED: "actioned",
} as const;
export type NotificationStatus =
  (typeof NotificationStatus)[keyof typeof NotificationStatus];

// ---------------------------------------------------------------------------
// Notification action (inline button in notification card)
// ---------------------------------------------------------------------------

export interface NotificationAction {
  label: string;
  action: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Notification row type (mirrors the DB select type without drizzle dep)
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: string;
  workspaceId: string;
  userId: string;
  type: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  title: string;
  body: string;
  icon: string | null;
  sourceType: string;
  sourceId: string | null;
  workspaceUrl: string | null;
  actions: unknown;
  groupKey: string | null;
  status: NotificationStatus;
  readAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}
