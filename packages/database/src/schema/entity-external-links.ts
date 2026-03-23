/**
 * Entity External Links Schema
 *
 * Tracks the mapping between Synap entities and their external source records
 * (e.g., Google Calendar event → Synap event entity).
 *
 * Used for:
 * - Deduplication during sync (upsert by provider + externalId)
 * - Change detection (sync_hash comparison)
 * - Disconnect handling (status = 'disconnected')
 * - Re-linking on reconnect
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

export const entityExternalLinks = pgTable(
  "entity_external_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .references(() => entities.id, { onDelete: "cascade" })
      .notNull(),
    provider: text("provider").notNull(), // "google-calendar", "github", etc.
    externalId: text("external_id").notNull(), // ID in the external system
    nangoConnectionId: text("nango_connection_id").notNull(), // Links back to CP connection
    status: text("status").notNull().default("active"), // "active" | "disconnected"
    syncHash: text("sync_hash"), // Hash of external record for change detection
    lastSyncedAt: timestamp("last_synced_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    disconnectedAt: timestamp("disconnected_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Core dedup index: one entity per external record per provider
    providerExternalIdIdx: uniqueIndex(
      "entity_external_links_provider_external_id_idx"
    ).on(table.provider, table.externalId),
    // Find all external links for an entity
    entityIdIdx: index("entity_external_links_entity_id_idx").on(
      table.entityId
    ),
    // Find all links for a provider (used during disconnect)
    providerIdx: index("entity_external_links_provider_idx").on(table.provider),
    // Find all links for a Nango connection (used during disconnect)
    nangoConnectionIdIdx: index(
      "entity_external_links_nango_connection_id_idx"
    ).on(table.nangoConnectionId),
    // Active links only
    statusIdx: index("entity_external_links_status_idx").on(table.status),
  })
);

export type EntityExternalLink = typeof entityExternalLinks.$inferSelect;
export type NewEntityExternalLink = typeof entityExternalLinks.$inferInsert;
