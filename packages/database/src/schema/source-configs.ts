/**
 * Source Configs & Source Subscriptions Schema
 *
 * Two tables powering the pluggable Feed source system (Phase 1 + 2).
 *
 * `source_configs`
 *   Pod-side, admin-managed provider configurations. One row = one
 *   "registered source the Pod knows how to talk to". Examples:
 *     - "Direct RSS feed at example.com"  (providerType='rss-direct')
 *     - "SerpAPI via our CP relay"       (providerType='cp-relay')
 *     - "Custom GitHub releases API"     (providerType='http-api')
 *
 *   The `config` JSONB stores provider-specific fields. Anything credential-
 *   like is stored as a `vault://<secret-uuid>/<field>` reference — the
 *   plaintext lives in `secrets` with `encryption_mode='server'`.
 *
 * `source_subscriptions`
 *   Binds a feed (owned by a researcher agent, created by Agent 3) to one
 *   source config + per-feed query params. Cursor-aware.
 *
 * Ownership model:
 *   - userId is the creator / owner.
 *   - workspaceId is nullable: a NULL workspaceId means "pod-wide" — the
 *     source config is visible to every workspace on this pod. A non-NULL
 *     workspaceId restricts visibility to that workspace.
 *
 * FK policy:
 *   - `source_subscriptions.source_config_id` uses ON DELETE CASCADE —
 *     deleting a source config removes its subscriptions (and the router
 *     additionally cleans up linked `secrets` rows by `serviceId`).
 *   - `source_subscriptions.feed_id` is a plain UUID — an opaque identifier
 *     that is not a FK to any table. It serves as context (e.g. channel ID
 *     or entity ID) for downstream workers. No ON DELETE CASCADE.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// ────────────────────────────────────────────────────────────────────────────
// source_configs
// ────────────────────────────────────────────────────────────────────────────

export const sourceConfigs = pgTable(
  "source_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Owner — the admin who created this source. */
    userId: text("user_id").notNull(),
    /** Null = pod-wide. Non-null restricts visibility to one workspace. */
    workspaceId: uuid("workspace_id"),

    /** Matches `ISourceProvider.meta.type` (e.g. 'rss-direct', 'http-api', 'cp-relay'). */
    providerType: text("provider_type").notNull(),

    name: text("name").notNull(),
    description: text("description"),

    /**
     * Provider-specific config JSONB. May contain `vault://<uuid>/<field>`
     * references that the executor resolves to plaintext via
     * resolveVaultReferences() before handing to the provider.
     */
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),

    enabled: boolean("enabled").notNull().default(true),

    // Last-known test probe state — populated by `testConnection` tRPC call.
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastTestStatus: text("last_test_status"), // 'ok' | 'error'
    lastTestError: text("last_test_error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdIdx: index("idx_source_configs_user_id").on(table.userId),
    providerTypeIdx: index("idx_source_configs_provider_type").on(
      table.providerType
    ),
    enabledIdx: index("idx_source_configs_enabled").on(table.enabled),
  })
);

// ────────────────────────────────────────────────────────────────────────────
// source_subscriptions
// ────────────────────────────────────────────────────────────────────────────

export const sourceSubscriptions = pgTable(
  "source_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),

    /** Opaque identifier for the feed (e.g. channel ID or entity ID). Not a FK. */
    feedId: uuid("feed_id").notNull(),

    sourceConfigId: uuid("source_config_id")
      .notNull()
      .references(() => sourceConfigs.id, { onDelete: "cascade" }),

    /** Per-feed params (e.g. { query: 'seed funding', route: '/rss/hn/frontpage' }). */
    params: jsonb("params")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** Opaque cursor from the previous successful fetch (ETag, lastId, etc.). */
    cursor: text("cursor"),

    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastItemAt: timestamp("last_item_at", { withTimezone: true }),

    /** 'active' | 'paused' | 'error' */
    status: text("status").notNull().default("active"),
    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    feedIdIdx: index("idx_source_subscriptions_feed_id").on(table.feedId),
    sourceConfigIdx: index("idx_source_subscriptions_source_config_id").on(
      table.sourceConfigId
    ),
    statusLastFetchedIdx: index(
      "idx_source_subscriptions_status_last_fetched"
    ).on(table.status, table.lastFetchedAt),
  })
);

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type SourceConfig = typeof sourceConfigs.$inferSelect;
export type NewSourceConfig = typeof sourceConfigs.$inferInsert;
export type SourceSubscription = typeof sourceSubscriptions.$inferSelect;
export type NewSourceSubscription = typeof sourceSubscriptions.$inferInsert;

export const SOURCE_SUBSCRIPTION_STATUSES = [
  "active",
  "paused",
  "error",
] as const;
export type SourceSubscriptionStatus =
  (typeof SOURCE_SUBSCRIPTION_STATUSES)[number];
