/**
 * Channel Egress Schema
 *
 * A channel-AGNOSTIC outbound action outbox. The backend enqueues outbound
 * actions here (rename a channel, post a message, pin, schedule an event) and
 * an external adapter (e.g. the Discord bridge) later PULLs pending rows and
 * executes them against the target system. This lets the backend stop calling
 * external systems (discord.com etc.) directly.
 *
 * Deliberately provider-agnostic: no Discord specifics in column names.
 * `externalSource` names the system ('discord', …) and `externalId` names the
 * target within it (a channel id). Nothing enqueues yet — Wave A infra only.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// channel_egress — outbound action outbox (agnostic)
// ---------------------------------------------------------------------------

export const channelEgress = pgTable(
  "channel_egress",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Which external system: 'discord' | … */
    externalSource: text("external_source").notNull(),

    /** Target id within that system (e.g. the channel id) */
    externalId: text("external_id").notNull(),

    /**
     * Action kind. One of:
     * 'post_message' | 'rename_channel' | 'pin_message' | 'scheduled_event'
     */
    kind: text("kind").notNull(),

    /** Kind-specific payload. Defaults to '{}' — never NULL. */
    payload: jsonb("payload")
      .notNull()
      .default({})
      .$type<Record<string, unknown>>(),

    /** Delivery status: 'pending' | 'delivered' | 'failed' */
    status: text("status").notNull().default("pending"),

    /** Delivery attempts; incremented by the adapter on failure. */
    attempts: integer("attempts").notNull().default(0),

    /** Last delivery error message (null until a failure occurs). */
    lastError: text("last_error"),

    /** Nullable — for audit / scoping only. */
    workspaceId: uuid("workspace_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Set when status transitions to 'delivered'. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    // Pending poll: status='pending' ordered by created_at asc.
    statusCreatedIdx: index("channel_egress_status_created_idx").on(
      table.status,
      table.createdAt
    ),
  })
);

export const insertChannelEgressSchema = createInsertSchema(channelEgress);
export const selectChannelEgressSchema = createSelectSchema(channelEgress);

export type ChannelEgress = typeof channelEgress.$inferSelect;
export type NewChannelEgress = typeof channelEgress.$inferInsert;
