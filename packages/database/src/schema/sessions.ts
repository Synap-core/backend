/**
 * Sessions Schema
 *
 * A session is a bounded period of interaction within a channel.
 * Sessions are the primary unit of the session-scoped memory system:
 * - When a session ends (inactivity timeout), its messages are compacted
 *   into a CompactedState for the next session to bootstrap from.
 * - Sessions group messages so the compaction engine knows which messages
 *   have already been processed and which are new.
 *
 * Session lifecycle:
 *   active → compacting → closed
 *
 * A new session starts when:
 * - There is no active session for the channel, OR
 * - The last message in the active session was > SESSION_TIMEOUT ago
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { channels } from "./channels.js";

export enum SessionStatus {
  ACTIVE = "active",
  COMPACTING = "compacting", // mid-session or end-of-session compaction in progress
  CLOSED = "closed",
}

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Which channel this session belongs to
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),

    // Timestamps
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { mode: "date", withTimezone: true }),
    // Updated on every message/token usage — used for session timeout checks
    lastActivityAt: timestamp("last_activity_at", {
      mode: "date",
      withTimezone: true,
    }),

    // Links to compacted states
    // bootstrapStateId: which compacted state was used to start this session
    bootstrapStateId: uuid("bootstrap_state_id"), // FK added after compacted_states is created

    // producedStateId: which compacted state this session produced (set after compaction)
    producedStateId: uuid("produced_state_id"), // FK added after compacted_states is created

    // Metrics
    totalTokensUsed: integer("total_tokens_used").default(0),
    messageCount: integer("message_count").default(0),
    compactionCount: integer("compaction_count").default(0),

    // Status
    status: text("status", {
      enum: [
        SessionStatus.ACTIVE,
        SessionStatus.COMPACTING,
        SessionStatus.CLOSED,
      ],
    })
      .notNull()
      .default(SessionStatus.ACTIVE),
  },
  (table) => ({
    channelIdIdx: index("sessions_channel_id_idx").on(table.channelId),
    channelStatusIdx: index("sessions_channel_status_idx").on(
      table.channelId,
      table.status
    ),
    startedAtIdx: index("sessions_started_at_idx").on(
      table.channelId,
      table.startedAt
    ),
  })
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export const insertSessionSchema = createInsertSchema(sessions);
export const selectSessionSchema = createSelectSchema(sessions);
