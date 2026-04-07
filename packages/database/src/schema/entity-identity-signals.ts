/**
 * Entity Identity Signals Schema
 *
 * Tracks cross-source identity indicators for an entity —
 * email addresses, phone numbers, social handles, profile URLs.
 *
 * Purpose:
 * - Cross-source dedup: same person from Telegram (phone) and LinkedIn (email)
 *   can be matched when both signals resolve to the same entity.
 * - O(1) lookup via unique index on (signal_type, signal_value).
 * - Source-agnostic: any import or connector can contribute signals.
 *
 * Values are normalized before storage (lowercase email, stripped phone, etc.).
 * See EntityUpsertService for the write path.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { entities } from "./entities.js";

export const entityIdentitySignals = pgTable(
  "entity_identity_signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .references(() => entities.id, { onDelete: "cascade" })
      .notNull(),
    /** Discriminator: 'email' | 'phone' | 'linkedin_url' | 'github_username' | 'telegram_phone' | ... */
    signalType: text("signal_type").notNull(),
    /**
     * Normalized signal value.
     * - email: lowercase + trimmed
     * - phone: digits only (+ prefix kept), e.g. "+33612345678"
     * - linkedin_url: lowercase, trailing slash removed
     * - github_username: lowercase
     */
    signalValue: text("signal_value").notNull(),
    /** Which source created this signal: 'telegram' | 'linkedin' | 'contacts' | 'connector:google' | ... */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Cross-entity uniqueness: one entity owns each (type, value) pair
    signalTypeValueIdx: uniqueIndex(
      "entity_identity_signals_type_value_idx"
    ).on(table.signalType, table.signalValue),
    // All signals for an entity (used during merge, profile view)
    entityIdIdx: index("entity_identity_signals_entity_id_idx").on(
      table.entityId
    ),
    // Find by type (e.g. all email signals)
    signalTypeIdx: index("entity_identity_signals_signal_type_idx").on(
      table.signalType
    ),
  })
);

export type EntityIdentitySignal = typeof entityIdentitySignals.$inferSelect;
export type NewEntityIdentitySignal = typeof entityIdentitySignals.$inferInsert;

/** Supported signal types */
export type IdentitySignalType =
  | "email"
  | "phone"
  | "linkedin_url"
  | "github_username"
  | "twitter_handle"
  | "telegram_phone"
  | "website";
