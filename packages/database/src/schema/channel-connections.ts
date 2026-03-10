/**
 * Channel Connections Schema
 *
 * Persistent mapping between external channel users (Telegram, WhatsApp)
 * and Synap users. Replaces the old in-memory user mapping in the channel gateway.
 *
 * Architecture (Option B):
 *   Gateway receives message → POST /api/channels/gateway/inbound to backend
 *   Backend looks up connection → calls IS → saves messages → returns text
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";

// ---------------------------------------------------------------------------
// channel_connections — maps external user → Synap user + workspace + thread
// ---------------------------------------------------------------------------

export const channelConnections = pgTable(
  "channel_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Which external channel: 'telegram' | 'whatsapp' | 'discord' */
    channel: text("channel").notNull(),

    /** External platform user identifier (e.g. Telegram user ID as string) */
    channelUserId: text("channel_user_id").notNull(),

    /** Synap user this connection belongs to */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Workspace to scope messages to (optional — null = pod-wide connection) */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),

    /**
     * Default channel/thread to send messages to.
     * Null = use the user's personal AI channel.
     */
    defaultChannelId: uuid("default_channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),

    /** Display name or username from the external platform (for UI display) */
    externalUsername: text("external_username"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One connection per (channel, channelUserId) — a Telegram user can only
    // link to one Synap account at a time
    uniqueChannelUser: unique("channel_connections_channel_user_unique").on(
      t.channel,
      t.channelUserId
    ),
    channelUserIdx: index("channel_connections_channel_user_idx").on(
      t.channel,
      t.channelUserId
    ),
    userIdx: index("channel_connections_user_idx").on(t.userId),
  })
);

export const insertChannelConnectionSchema =
  createInsertSchema(channelConnections);
export const selectChannelConnectionSchema =
  createSelectSchema(channelConnections);
export type ChannelConnection = typeof channelConnections.$inferSelect;
export type NewChannelConnection = typeof channelConnections.$inferInsert;

// ---------------------------------------------------------------------------
// channel_link_tokens — single-use tokens for the /link flow
// ---------------------------------------------------------------------------

export const channelLinkTokens = pgTable(
  "channel_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Short, user-friendly token (8 chars alphanumeric) */
    token: text("token").notNull().unique(),

    /** Which external channel this token is intended for */
    channel: text("channel").notNull(),

    /** Synap user who generated the token */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Workspace to associate the connection with (optional — null = pod-wide) */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),

    /** Optional: pre-assigned channel to use for this connection */
    defaultChannelId: uuid("default_channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),

    /** Token expires after this time (default: 15 minutes) */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /** Set when token is consumed — idempotency guard */
    usedAt: timestamp("used_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tokenIdx: index("channel_link_tokens_token_idx").on(t.token),
    userIdx: index("channel_link_tokens_user_idx").on(t.userId),
  })
);

export const insertChannelLinkTokenSchema =
  createInsertSchema(channelLinkTokens);
export const selectChannelLinkTokenSchema =
  createSelectSchema(channelLinkTokens);
export type ChannelLinkToken = typeof channelLinkTokens.$inferSelect;
export type NewChannelLinkToken = typeof channelLinkTokens.$inferInsert;
