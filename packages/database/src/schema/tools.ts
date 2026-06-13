/**
 * Tools Schema — registered integrations the AI can use
 *
 * CONFIGURATION (not entity DATA). A Tool is a registered integration: an API,
 * MCP server, data-source provider, a builtin IS tool, or an external (BYOA)
 * tool. It owns the credential binding (an opaque vault:// ref) and an input
 * schema. Skills `require` Tools; Playbooks `grant` Tools (see the `links`
 * table). Part of the Playbooks & Capability Substrate
 * (team/platform/playbooks-capability-substrate.mdx).
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/** The kind of integration a Tool represents. */
export type ToolKind = "builtin" | "api" | "mcp" | "provider" | "external";
/** Which "hands" run this Tool. Mirrors @synap/playbooks ExecutorRef. */
export type ToolExecutorRef = "is-agent" | "external-agent" | "hybrid";

export const tools = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Nullable = pod-wide (visible to all workspaces). */
    workspaceId: uuid("workspace_id"),
    /** Owning principal — human user id or agent-user id. */
    createdBy: text("created_by").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").$type<ToolKind>().notNull(),
    /** JSON Schema for the tool's invocation arguments. */
    inputSchema: jsonb("input_schema").notNull().default({}),
    /** Opaque vault reference (vault://…), resolved server-side per executor. */
    credentialRef: text("credential_ref"),
    executor: text("executor", {
      enum: ["is-agent", "external-agent", "hybrid"],
    })
      .$type<ToolExecutorRef>()
      .notNull()
      .default("is-agent"),
    /** Provider-specific config (may contain vault:// refs). */
    config: jsonb("config").notNull().default({}),
    status: text("status", { enum: ["active", "inactive", "error"] })
      .notNull()
      .default("active"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceIdIdx: index("idx_tools_workspace_id").on(table.workspaceId),
    kindIdx: index("idx_tools_kind").on(table.kind),
  })
);

export type Tool = typeof tools.$inferSelect;
export type NewTool = typeof tools.$inferInsert;
export const insertToolSchema = createInsertSchema(tools);
export const selectToolSchema = createSelectSchema(tools);
