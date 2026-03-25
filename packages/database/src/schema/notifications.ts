import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Notification Categories & Priorities
// ---------------------------------------------------------------------------

export const NotificationCategory = {
  GOVERNANCE: "governance", // proposals, AI requests
  DATA: "data", // connector syncs, entity events
  AI: "ai", // agent completions, skill triggers
  SYSTEM: "system", // updates, errors, storage
  INBOX: "inbox", // external messages (Gmail, Slack, etc.)
} as const;
export type NotificationCategory =
  (typeof NotificationCategory)[keyof typeof NotificationCategory];

export const NotificationPriority = {
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
  URGENT: "urgent",
} as const;
export type NotificationPriority =
  (typeof NotificationPriority)[keyof typeof NotificationPriority];

export const NotificationStatus = {
  UNREAD: "unread",
  READ: "read",
  DISMISSED: "dismissed",
  ACTIONED: "actioned",
} as const;
export type NotificationStatus =
  (typeof NotificationStatus)[keyof typeof NotificationStatus];

// ---------------------------------------------------------------------------
// notifications table
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Scoping
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(), // recipient

    // Type (registry key — e.g. 'proposal.created', 'connector.sync.complete')
    type: text("type").notNull(),
    category: text("category", {
      enum: [
        NotificationCategory.GOVERNANCE,
        NotificationCategory.DATA,
        NotificationCategory.AI,
        NotificationCategory.SYSTEM,
        NotificationCategory.INBOX,
      ],
    }).notNull(),
    priority: text("priority", {
      enum: [
        NotificationPriority.LOW,
        NotificationPriority.NORMAL,
        NotificationPriority.HIGH,
        NotificationPriority.URGENT,
      ],
    })
      .notNull()
      .default(NotificationPriority.NORMAL),

    // Content (evaluated from registry templates at creation)
    title: text("title").notNull(),
    body: text("body").notNull(),
    icon: text("icon"), // lucide icon name

    // Source traceability
    sourceType: text("source_type").notNull(), // 'proposal' | 'connector' | 'agent' | 'system'
    sourceId: text("source_id"), // FK to source entity (proposalId, etc.)
    workspaceUrl: text("workspace_url"), // deep-link on click

    // Inline actions (JSON array of NotificationAction)
    actions: jsonb("actions").default("[]"),

    // Grouping — same groupKey → collapse in bell panel
    groupKey: text("group_key"),

    // State
    status: text("status", {
      enum: [
        NotificationStatus.UNREAD,
        NotificationStatus.READ,
        NotificationStatus.DISMISSED,
        NotificationStatus.ACTIONED,
      ],
    })
      .notNull()
      .default(NotificationStatus.UNREAD),
    readAt: timestamp("read_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Primary query pattern: bell (unread for user in workspace)
    idxUserWorkspaceStatus: index("notifs_user_workspace_status_idx").on(
      t.userId,
      t.workspaceId,
      t.status,
      t.createdAt
    ),
    // Grouping queries
    idxGroupKey: index("notifs_group_key_idx").on(t.groupKey, t.workspaceId),
    // Source lookup (e.g. find notification for a proposal)
    idxSource: index("notifs_source_idx").on(t.sourceType, t.sourceId),
  })
);

export const insertNotificationSchema = createInsertSchema(notifications);
export const selectNotificationSchema = createSelectSchema(notifications);
export type Notification = z.infer<typeof selectNotificationSchema>;
export type NewNotification = z.infer<typeof insertNotificationSchema>;

// ---------------------------------------------------------------------------
// notification_preferences table
// ---------------------------------------------------------------------------

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),

    // Global kill switch
    enabled: boolean("enabled").notNull().default(true),

    // Quiet hours (local time, user's timezone)
    quietHoursEnabled: boolean("quiet_hours_enabled").default(false),
    quietHoursStart: text("quiet_hours_start").default("22:00"), // "HH:MM"
    quietHoursEnd: text("quiet_hours_end").default("08:00"),

    // Per-type routing rules:
    // { [notificationType]: "in_app" | "os" | "telegram" | "all" | "mute" }
    routingRules: jsonb("routing_rules").default("{}"),

    // Sound preference
    soundEnabled: boolean("sound_enabled").default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    idxUserWorkspace: index("notif_prefs_user_workspace_idx").on(
      t.userId,
      t.workspaceId
    ),
  })
);

export const insertNotificationPreferencesSchema = createInsertSchema(
  notificationPreferences
);
export const selectNotificationPreferencesSchema = createSelectSchema(
  notificationPreferences
);
export type NotificationPreferences = z.infer<
  typeof selectNotificationPreferencesSchema
>;
