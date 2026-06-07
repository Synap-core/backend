/**
 * AI Provider Credentials — per-workspace and per-user key overrides.
 *
 * Resolution order at inference time: user-level > workspace-level > pod-wide.
 * Keys are stored server-side encrypted (same as ai_providers.encrypted_api_key)
 * so the backend can decrypt and forward them to the IS at request time.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

export const aiProviderCredentials = pgTable(
  "ai_provider_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** IS-internal provider id — matches ai_providers.provider_id */
    providerId: text("provider_id").notNull(),

    /**
     * Workspace scope. NULL means this is a per-user credential (userId required).
     * When set and userId is NULL, this is a workspace-level override.
     */
    workspaceId: uuid("workspace_id"),

    /**
     * User scope. NULL means this is a workspace-level credential (workspaceId required).
     * When set, this is a per-user override (may also have workspaceId to scope it).
     */
    userId: text("user_id"),

    /** API key encrypted with encryptServiceKey — never stored in plaintext */
    encryptedApiKey: text("encrypted_api_key").notNull(),

    /** Whether this override is active */
    enabled: boolean("enabled").notNull().default(true),

    /** Local priority within the same scope tier */
    priority: integer("priority").notNull().default(10),

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("ai_provider_credentials_unique").on(
      t.providerId,
      t.workspaceId,
      t.userId
    ),
    index("ai_provider_credentials_workspace_idx").on(t.workspaceId),
    index("ai_provider_credentials_user_idx").on(t.userId),
    index("ai_provider_credentials_provider_idx").on(t.providerId),
  ]
);

export type AiProviderCredential = typeof aiProviderCredentials.$inferSelect;
export type NewAiProviderCredential = typeof aiProviderCredentials.$inferInsert;
