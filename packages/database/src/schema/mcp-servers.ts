/**
 * MCP Servers Schema
 *
 * Workspace-level MCP (Model Context Protocol) server configurations.
 * Promoted from workspaces.settings.mcpServers[] (JSONB array) to a
 * proper table for per-server status tracking, approval gating, and
 * efficient queries.
 *
 * An MCP server exposes tools that AI agents can call. Each server must
 * be explicitly approved by a workspace owner before its tools are injected
 * into LLM requests.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export type McpTransport = "stdio" | "http" | "sse";
export type McpStatus = "connected" | "disconnected" | "error" | "unknown";

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    /** Human-readable unique identifier within the workspace, e.g. 'playwright' */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    // ── Connection config ────────────────────────────────────────────────

    /** Transport mechanism */
    transport: text("transport", {
      enum: ["stdio", "http", "sse"],
    })
      .notNull()
      .$type<McpTransport>(),

    /** stdio: executable path or command name (e.g. 'npx') */
    command: text("command"),

    /** stdio: arguments (e.g. ['@playwright/mcp@latest']) */
    args: jsonb("args").$type<string[]>().default([]).notNull(),

    /** http/sse: server URL */
    url: text("url"),

    /** Environment variables injected into the server process */
    env: jsonb("env").$type<Record<string, string>>().default({}).notNull(),

    // ── Lifecycle ────────────────────────────────────────────────────────

    enabled: boolean("enabled").default(true).notNull(),

    /**
     * Workspace owner must explicitly approve before tools are injected
     * into LLM requests. Prevents supply-chain attacks via rogue MCP servers.
     */
    approved: boolean("approved").default(false).notNull(),

    // ── Runtime health ───────────────────────────────────────────────────

    status: text("status", {
      enum: ["connected", "disconnected", "error", "unknown"],
    })
      .default("unknown")
      .notNull()
      .$type<McpStatus>(),

    lastPingAt: timestamp("last_ping_at", {
      mode: "date",
      withTimezone: true,
    }),

    errorMessage: text("error_message"),

    /**
     * Free-form metadata from the server's manifest
     * e.g. { capabilities: ['browse', 'screenshot'], version: '1.2.0' }
     */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueWorkspaceSlug: unique("mcp_servers_workspace_slug_unique").on(
      table.workspaceId,
      table.slug
    ),
    workspaceIdIdx: index("mcp_servers_workspace_id_idx").on(table.workspaceId),
    statusIdx: index("mcp_servers_status_idx").on(table.status),
  })
);

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
