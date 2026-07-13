/**
 * Durable AI chat turn ledger.
 *
 * A turn is the authoritative lifecycle record for one user request.  It is
 * deliberately separate from `messages`: messages are the durable timeline,
 * while turns/events are the resumable transport journal which lets a sender
 * reconnect without creating a second model invocation.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { channels } from "./channels.js";

export const ChatTurnStatus = {
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type ChatTurnStatus =
  (typeof ChatTurnStatus)[keyof typeof ChatTurnStatus];

export const chatTurns = pgTable(
  "chat_turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** Client-generated UUID. Unique per user; it identifies one user intent,
     * including Home's first turn before a channel is known. */
    requestId: uuid("request_id").notNull(),
    /** Allocated before model work so UI identity never changes mid-stream. */
    userMessageId: uuid("user_message_id").notNull(),
    assistantMessageId: uuid("assistant_message_id").notNull(),
    status: text("status", {
      enum: [
        ChatTurnStatus.RUNNING,
        ChatTurnStatus.COMPLETED,
        ChatTurnStatus.FAILED,
        ChatTurnStatus.CANCELLED,
      ],
    })
      .notNull()
      .default(ChatTurnStatus.RUNNING),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userRequestUnique: uniqueIndex("chat_turns_user_request_unique").on(
      table.userId,
      table.requestId
    ),
    userMessageUnique: uniqueIndex("chat_turns_user_message_unique").on(
      table.userMessageId
    ),
    assistantMessageUnique: uniqueIndex(
      "chat_turns_assistant_message_unique"
    ).on(table.assistantMessageId),
    channelStartedIdx: index("chat_turns_channel_started_idx").on(
      table.channelId,
      table.startedAt
    ),
  })
);

export const chatTurnEvents = pgTable(
  "chat_turn_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => chatTurns.id, { onDelete: "cascade" }),
    /** Monotonic per turn, never reused. */
    seq: integer("seq").notNull(),
    /** Stable client-facing event identity for dedupe after reconnect. */
    eventId: uuid("event_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    turnSeqUnique: uniqueIndex("chat_turn_events_turn_seq_unique").on(
      table.turnId,
      table.seq
    ),
    eventIdUnique: uniqueIndex("chat_turn_events_event_id_unique").on(
      table.eventId
    ),
    turnSeqIdx: index("chat_turn_events_turn_seq_idx").on(
      table.turnId,
      table.seq
    ),
  })
);
