/**
 * Message Reactions — per-message emoji reactions (Discord parity).
 *
 * One row per (message, user, emoji) triple. Toggle semantics: inserting the
 * same triple is an UPSERT no-op; the `toggleReaction` mutation deletes when
 * the row already exists, inserts otherwise.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { messages } from "./messages.js";

export const messageReactions = pgTable(
  "message_reactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    messageIdIdx: index("message_reactions_message_id_idx").on(table.messageId),
    uniqueReaction: uniqueIndex("message_reactions_unique").on(
      table.messageId,
      table.userId,
      table.emoji
    ),
  })
);

export type MessageReaction = typeof messageReactions.$inferSelect;
export type NewMessageReaction = typeof messageReactions.$inferInsert;
