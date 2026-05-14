/**
 * Messaging Accounts Schema
 *
 * Stores one row per user+platform connected account for the provider-agnostic
 * messaging connector (e.g. a user's LinkedIn account via Unipile).
 *
 * `external_id` is the provider's account identifier (Unipile account_id).
 * The (user_id, provider, external_id) triple is unique — reconnecting the same
 * account updates the existing row rather than creating a duplicate.
 */

import {
  pgTable,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ────────────────────────────────────────────────────────────────────────────
// messaging_accounts
// ────────────────────────────────────────────────────────────────────────────

export const messagingAccounts = pgTable(
  "messaging_accounts",
  {
    id: text("id").primaryKey().default("gen_random_uuid()::text"),

    /** Owner of this connected account. */
    userId: text("user_id").notNull(),

    /** Platform identifier (e.g. 'linkedin', 'gmail', 'whatsapp'). */
    provider: text("provider").notNull(),

    /** Provider-assigned account ID (e.g. Unipile account_id). */
    externalId: text("external_id").notNull(),

    /** Human-readable label shown in the UI (e.g. "John Doe"). */
    displayName: text("display_name").notNull().default(""),

    /** 'connected' | 'reconnection_required' | 'disconnected' */
    status: text("status").notNull().default("connected"),

    /** Provider-specific metadata (tokens, scopes, webhook ids, etc.). */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdIdx: index("idx_messaging_accounts_user_id").on(table.userId),
    userProviderExternalIdx: uniqueIndex(
      "idx_messaging_accounts_user_provider_external"
    ).on(table.userId, table.provider, table.externalId),
  })
);

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type MessagingAccount = typeof messagingAccounts.$inferSelect;
export type NewMessagingAccount = typeof messagingAccounts.$inferInsert;

export const MESSAGING_ACCOUNT_STATUSES = [
  "connected",
  "reconnection_required",
  "disconnected",
] as const;
export type MessagingAccountStatus =
  (typeof MESSAGING_ACCOUNT_STATUSES)[number];
