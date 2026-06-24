/**
 * Provider Integrations Schema — metadata registry for credential backends
 *
 * Two tables, both METADATA-ONLY (no execution logic):
 *
 * `providers` — credential backend platforms (Nango, Vault, Unipile, etc.).
 *   Each provider is a TYPE of credential infrastructure. The RUNTIME counterpart
 *   lives in the ConnectorRegistry (JavaScript class); this table is the DB-side
 *   registry so the UI and the dispatcher can discover "what providers exist"
 *   without hardcoding them.
 *
 * `provider_integrations` — specific services each provider exposes
 *   (Gmail, GDrive, Outlook, Slack under Nango; OpenAI, Apify, Apollo under Vault).
 *   A `secrets` row with `provider_integration_id` set means the vault secret
 *   routes through that provider's credential lifecycle (OAuth flow, token refresh,
 *   proxy) instead of being injected as a raw API key.
 *
 * Design: the new tables are ADDITIVE — no column removal, no data migration
 * needed today. The existing `nango://` scheme handler in the dispatcher is kept
 * as a backward-compat path for existing tool rows; new tools use
 * `credentialRef = vault://<secretId>` where the secret carries the
 * `provider_integration_id` FK.
 *
 * Part of the Playbooks & Capability Substrate.
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ── providers ─────────────────────────────────────────────────────────────────
//
// The credential platform/backend. Examples:
//   name="nango",   backend_type="nango"
//   name="vault",   backend_type="vault"
//   name="unipile", backend_type="unipile"

export const providers = pgTable(
  "providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable slug (e.g. "nango", "vault", "unipile"). Matches the
     * ConnectorRegistry type key. */
    slug: text("slug").notNull().unique(),
    /** Human-readable name (e.g. "Nango", "Synap Vault", "Unipile"). */
    displayName: text("display_name").notNull(),
    description: text("description"),
    /**
     * Credential backend type:
     *   "nango"   — OAuth proxy (token refresh, connection management via Nango)
     *   "vault"   — direct API key injection (server-encrypted vault)
     *   "unipile" — messaging gateway (Unipile DSN)
     */
    backendType: text("backend_type").notNull(),
    logoUrl: text("logo_url"),
    /** Arbitrary provider metadata (version, docs URL, etc.). */
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    backendTypeIdx: index("idx_providers_backend_type").on(table.backendType),
  })
);

// ── provider_integrations ─────────────────────────────────────────────────────
//
// One specific service under a provider. Examples:
//   provider=nango, slug="gmail",     backend_config={ providerConfigKey: "gmail" }
//   provider=nango, slug="gdrive",    backend_config={ providerConfigKey: "gdrive" }
//   provider=nango, slug="outlook",   backend_config={ providerConfigKey: "outlook" }
//   provider=nango, slug="slack",     backend_config={ providerConfigKey: "slack" }
//   provider=vault, slug="openai",    backend_config={ serviceId: "openai" }
//   provider=vault, slug="apify",     backend_config={ serviceId: "apify" }

export const providerIntegrations = pgTable(
  "provider_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Parent provider (Nango, Vault, etc.). */
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    /** Integration slug, unique within a provider (e.g. "gmail", "openai"). */
    slug: text("slug").notNull(),
    /** Human-readable name (e.g. "Gmail", "OpenAI API"). */
    displayName: text("display_name").notNull(),
    description: text("description"),
    /**
     * Provider-specific routing config.
     * For Nango: { providerConfigKey: "gmail" }
     * For Vault: { serviceId: "openai" }
     */
    backendConfig: jsonb("backend_config").notNull().default({}),
    logoUrl: text("logo_url"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    providerIdIdx: index("idx_provider_integrations_provider_id").on(
      table.providerId
    ),
    // One slug per provider (no two "gmail" integrations under the same provider)
    providerSlugUnique: uniqueIndex(
      "idx_provider_integrations_provider_slug"
    ).on(table.providerId, table.slug),
  })
);

// ── Types ─────────────────────────────────────────────────────────────────────

export type Provider = typeof providers.$inferSelect;
export type NewProvider = typeof providers.$inferInsert;
export type ProviderIntegration = typeof providerIntegrations.$inferSelect;
export type NewProviderIntegration = typeof providerIntegrations.$inferInsert;

export const insertProviderSchema = createInsertSchema(providers);
export const selectProviderSchema = createSelectSchema(providers);
export const insertProviderIntegrationSchema =
  createInsertSchema(providerIntegrations);
export const selectProviderIntegrationSchema =
  createSelectSchema(providerIntegrations);

// ── Relations ─────────────────────────────────────────────────────────────────

import { relations } from "drizzle-orm";
import { secrets } from "./secrets-vault.js";

export const providersRelations = relations(providers, ({ many }) => ({
  integrations: many(providerIntegrations),
}));

export const providerIntegrationsRelations = relations(
  providerIntegrations,
  ({ one, many }) => ({
    provider: one(providers, {
      fields: [providerIntegrations.providerId],
      references: [providers.id],
    }),
    secrets: many(secrets),
  })
);
