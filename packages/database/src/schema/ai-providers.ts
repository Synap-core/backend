/**
 * AI Providers Schema
 *
 * Pod-level registry of AI model providers. Source of truth for provider
 * configuration — decoupled from any specific IntelligenceSystem or workspace.
 * The backend syncs this to the active IS on every change.
 *
 * API keys are stored server-side encrypted via encryptServiceKey/decryptServiceKey.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export interface AiProviderModelEntry {
  id: string;
  tier?: "free" | "balanced" | "advanced" | "complex";
  contextWindow?: number;
  supportsTools?: boolean;
  supportsJson?: boolean;
  costPer1MInput?: number;
  costPer1MOutput?: number;
}

export const aiProviders = pgTable(
  "ai_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** IS-internal provider id (e.g. "openrouter", "anthropic", "qwen-local") */
    providerId: text("provider_id").notNull().unique(),

    /** Display name */
    name: text("name").notNull(),

    /** OpenAI-compatible base URL for the provider */
    baseUrl: text("base_url").notNull(),

    /** Env var name the IS uses to read the key (e.g. "OPENROUTER_API_KEY") */
    apiKeyEnvVar: text("api_key_env_var").notNull(),

    /** API key encrypted with encryptServiceKey — never stored in plaintext */
    encryptedApiKey: text("encrypted_api_key"),

    enabled: boolean("enabled").notNull().default(true),

    /** Lower = higher priority in the IS cascade */
    priority: integer("priority").notNull().default(10),

    tags: jsonb("tags").$type<string[]>().notNull().default([]),

    /** Model definitions — tier, context window, capabilities, pricing */
    models: jsonb("models")
      .$type<AiProviderModelEntry[]>()
      .notNull()
      .default([]),

    rateLimit: jsonb("rate_limit").$type<{ rpm: number; rpd?: number }>(),

    /** Extra fields merged into every chat completions body (e.g. no-think flags) */
    extraBody: jsonb("extra_body").$type<Record<string, unknown>>(),

    /** Prefix injected at the start of the system message */
    systemPromptPrefix: text("system_prompt_prefix"),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("ai_providers_provider_id_idx").on(t.providerId)]
);

export type AiProvider = typeof aiProviders.$inferSelect;
export type NewAiProvider = typeof aiProviders.$inferInsert;
