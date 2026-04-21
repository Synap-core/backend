/**
 * Intelligence Services Schema
 *
 * Registry of external intelligence services that can process data
 * from the Data Pod (e.g., Synap Intelligence Service, third-party AI providers)
 */

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  uuid,
} from "drizzle-orm/pg-core";

export const intelligenceServices = pgTable("intelligence_services", {
  id: text("id").primaryKey(),

  // Service identification
  serviceId: text("service_id").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  version: text("version"),

  // Service endpoints
  webhookUrl: text("webhook_url").notNull(),
  /** MCP server URL exposed by this service (e.g. ZeroClaw/OpenClaw local tools via MCP) */
  mcpEndpoint: text("mcp_endpoint"),

  // Authentication
  apiKey: text("api_key").notNull(), // For authenticating callbacks from service

  // Capabilities (what this service can do)
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),

  // Pricing model
  pricing: text("pricing").default("free"), // 'free', 'premium', 'enterprise', 'custom'

  // Status
  status: text("status").notNull().default("active"), // 'active', 'inactive', 'suspended'
  enabled: boolean("enabled").notNull().default(true),

  /**
   * Whether this service's MCP endpoint is approved to inject tools into LLM requests.
   * Default false — must be explicitly approved by workspace owner/admin or auto-approved
   * via the trusted Hub Protocol provisioning path (control plane sets this to true).
   */
  mcpApproved: boolean("mcp_approved").notNull().default(false),

  /** Human-readable provider type (e.g. 'openai', 'anthropic', 'self-hosted', 'custom') */
  providerType: text("provider_type"),

  /** Whether to automatically sync agent list from this service into the agents table */
  agentListSyncEnabled: boolean("agent_list_sync_enabled")
    .notNull()
    .default(false),

  // Metadata
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastHealthCheck: timestamp("last_health_check"),
  /**
   * Last known health status — persisted so routing and UI can use it
   * without having to re-ping. Updated by the intelligence-health-check cron job.
   * "healthy" | "degraded" | "unhealthy"
   */
  lastHealthStatus: text("last_health_status"),
});

export type IntelligenceService = typeof intelligenceServices.$inferSelect;
export type NewIntelligenceService = typeof intelligenceServices.$inferInsert;
