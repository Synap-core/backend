import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { messagingAccounts } from "./messaging-accounts.js";

export const messagingThreadLinks = pgTable(
  "messaging_thread_links",
  {
    id: text("id").primaryKey().default("gen_random_uuid()::text"),

    /** Unipile chat ID (external). */
    externalThreadId: text("external_thread_id").notNull(),

    /** The messaging_accounts row whose credentials are used to read this thread. */
    accountId: text("account_id")
      .notNull()
      .references(() => messagingAccounts.id, { onDelete: "cascade" }),

    /** CRM entity this thread is linked to (person, deal, company, client). */
    entityId: text("entity_id").notNull(),

    /** User who created the link. */
    linkedByUserId: text("linked_by_user_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    entityIdx: index("idx_msg_thread_links_entity_id").on(table.entityId),
    threadEntityUniq: uniqueIndex("idx_msg_thread_links_thread_entity").on(
      table.externalThreadId,
      table.entityId
    ),
  })
);

export type MessagingThreadLink = typeof messagingThreadLinks.$inferSelect;
export type NewMessagingThreadLink = typeof messagingThreadLinks.$inferInsert;
