/**
 * API Keys Schema - Drizzle ORM
 *
 * Hub Protocol V1.0 - Phase 2
 *
 * API keys for Hub authentication with bcrypt hashing and complete audit trail.
 * Based on industry best practices from GitHub, Stripe, and AWS.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  bigint,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * API Keys Table
 *
 * Stores API keys with bcrypt hashing for security.
 * Supports key rotation, expiration, and complete audit trail.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    // Primary Key
    id: uuid("id").primaryKey().defaultRandom(),

    // Ownership
    userId: text("user_id").notNull(),

    // Key Identification
    keyName: text("key_name").notNull(), // User-friendly name
    keyPrefix: text("key_prefix").notNull(), // 'synap_hub_live_', 'synap_hub_test_', 'synap_user_'
    keyHash: text("key_hash").notNull(), // Bcrypt hash (cost factor 12)

    // Metadata
    hubId: text("hub_id"), // NULL for user keys, set for Hub keys
    scope: text("scope")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`), // Granular permissions
    expiresAt: timestamp("expires_at", { withTimezone: true }), // NULL = no expiration

    // State
    isActive: boolean("is_active").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    usageCount: bigint("usage_count", { mode: "number" }).notNull().default(0),

    // Rotation
    rotatedFromId: uuid("rotated_from_id"), // Will add reference after table definition
    rotationScheduledAt: timestamp("rotation_scheduled_at", {
      withTimezone: true,
    }),

    // Audit Trail
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by"), // User ID who created
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"), // User ID who revoked
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    // Constraints
    userIdCheck: check(
      "api_keys_user_id_check",
      sql`${table.userId} IS NOT NULL AND LENGTH(TRIM(${table.userId})) > 0`
    ),
    keyNameCheck: check(
      "api_keys_key_name_check",
      sql`LENGTH(TRIM(${table.keyName})) > 0`
    ),
    keyPrefixCheck: check(
      "api_keys_key_prefix_check",
      sql`${table.keyPrefix} IN ('synap_hub_live_', 'synap_hub_test_', 'synap_user_')`
    ),
    keyHashUnique: unique("api_keys_key_hash_unique").on(table.keyHash),
  })
);

/**
 * TypeScript type for API Key record
 */
export type ApiKeyRecord = typeof apiKeys.$inferSelect;

/**
 * TypeScript type for API Key insert
 */
export type ApiKeyInsert = typeof apiKeys.$inferInsert;

/**
 * Valid key prefixes
 */
export const KEY_PREFIXES = {
  HUB_LIVE: "synap_hub_live_",
  HUB_TEST: "synap_hub_test_",
  USER: "synap_user_",
} as const;

/**
 * Valid scopes for API keys
 */
export const API_KEY_SCOPES = [
  "preferences",
  "calendar",
  "notes",
  "tasks",
  "projects",
  "conversations",
  "entities",
  "relations",
  "knowledge_facts",
  // n8n integration scopes
  "write:entities", // Create/update/delete entities via n8n
  "read:entities", // Search and read entities via n8n
  "ai:analyze", // AI content analysis
  "webhook:manage", // Manage webhook subscriptions (Phase 2)
  // Hub Protocol scopes (for Intelligence Hub)
  "hub-protocol.read", // Read context from Data Pod
  "hub-protocol.write", // Write results back to Data Pod
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Helper to check if a scope is valid
 */
export function isValidScope(scope: string): scope is ApiKeyScope {
  return API_KEY_SCOPES.includes(scope as ApiKeyScope);
}
