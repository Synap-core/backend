/**
 * API Key External Users — per-external-user sub-token mapping
 *
 * Hub Protocol per-user sub-token system (gated by HUB_PROTOCOL_SUB_TOKENS).
 *
 * One row per (parent_api_key, external_user_id) pair. The parent key is the
 * agent key minted by POST /setup/agent. The external_user_id is whatever
 * opaque identifier the upstream service sends (e.g. OpenWebUI's user.id).
 * The mapping resolves to a Synap user, optionally backed by a real child
 * api_key (Mode 2 — sub-token).
 *
 * See migration 0018_per_user_sub_tokens.sql for the schema definition and
 * api-keys.ts for the parent_key_id column on the api_keys side.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

import { apiKeys } from "./api-keys.js";
import { users } from "./users.js";

export interface ApiKeyExternalUserMetadata {
  /** Source label — e.g. "openwebui", "telegram", "slack". */
  source?: string;
  /** Optional human-friendly display name passed through at create time. */
  displayName?: string;
  /** Optional email address provided by the external system. */
  email?: string;
  /** Free-form extras the integration wants to remember. */
  [key: string]: unknown;
}

export const apiKeyExternalUsers = pgTable(
  "api_key_external_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Parent agent key — the one minted by /setup/agent. */
    parentApiKeyId: uuid("parent_api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),

    /** Opaque external user identifier (e.g. OWUI user.id). */
    externalUserId: text("external_user_id").notNull(),

    /** The Synap user this mapping resolves to. */
    synapUserId: text("synap_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * Optional child api_key (Mode 2 — sub-token). When set, the bearer carries
     * a real per-user token. NULL for Mode 1 (header-based remap).
     */
    childApiKeyId: uuid("child_api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),

    metadata: jsonb("metadata")
      .notNull()
      .default({})
      .$type<ApiKeyExternalUserMetadata>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Bumped (debounced) on every successful mapping resolution. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    parentExternalUnique: unique("api_key_external_users_unique").on(
      table.parentApiKeyId,
      table.externalUserId
    ),
  })
);

export type ApiKeyExternalUserRecord = typeof apiKeyExternalUsers.$inferSelect;
export type ApiKeyExternalUserInsert = typeof apiKeyExternalUsers.$inferInsert;

export const apiKeyExternalUsersRelations = relations(
  apiKeyExternalUsers,
  ({ one }) => ({
    parentApiKey: one(apiKeys, {
      fields: [apiKeyExternalUsers.parentApiKeyId],
      references: [apiKeys.id],
      relationName: "apiKeyExternalUsersParentKey",
    }),
    childApiKey: one(apiKeys, {
      fields: [apiKeyExternalUsers.childApiKeyId],
      references: [apiKeys.id],
      relationName: "apiKeyExternalUsersChildKey",
    }),
    synapUser: one(users, {
      fields: [apiKeyExternalUsers.synapUserId],
      references: [users.id],
    }),
  })
);
