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
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/** The kind of integration a Tool represents. */
export type ToolKind =
  | "builtin"
  | "api"
  | "mcp"
  | "provider"
  | "external"
  | "script";
/** Which "hands" run this Tool. Mirrors @synap/playbooks ExecutorRef. */
export type ToolExecutorRef = "is-agent" | "external-agent" | "hybrid";

/**
 * One verb in a Tool's structured capability catalog (the capability-matrix
 * axis). Kept in lock-step with `ToolVerb` in @synap/playbooks — re-declared here
 * (not imported) so the schema package stays dependency-free, exactly like the
 * other `.$type<>()` unions in this file.
 */
export type ToolVerbCatalogEntry = {
  /** Stable id — the requiring skill's name. */
  id: string;
  label: string;
  /** read = pull · write/action = push. */
  kind: "read" | "write" | "action";
  argsSchema?: Record<string, unknown>;
  /** Aligns to the seeded grant exec-mode. */
  govDefault: "auto" | "propose" | "dry-run";
};

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
    /**
     * Structured verb catalog — the enumerable capability-matrix axis. Each entry
     * is one operation the AI can invoke on this tool (id = a requiring skill's
     * name; kind = read/write/action; govDefault aligns to the seeded grant
     * exec-mode). Derived from the `CapabilityDefinition` at apply time
     * (`createCapabilityFromDefinition`), never hand-authored. Empty `[]` for a
     * verb-less tool (e.g. a bare connect that hasn't applied its family template).
     */
    capabilities: jsonb("capabilities")
      .$type<ToolVerbCatalogEntry[]>()
      .notNull()
      .default([]),
    status: text("status", { enum: ["active", "inactive", "error"] })
      .notNull()
      .default("active"),
    /**
     * Per-capability approval gate (orthogonal to `status`, which is
     * lifecycle/health). A tool is born NOT approved (DEFAULT false) so a
     * freshly-created/AI-seeded tool cannot execute until an owner approves it.
     * The dispatcher (`external-dispatch.ts`) refuses to run an unapproved tool.
     * Mirrors `mcp_servers.approved`. Existing rows are grandfathered to true by
     * migration 0143.
     */
    approved: boolean("approved").notNull().default(false),
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
    approvedIdx: index("idx_tools_approved").on(table.approved),
    // Pod-wide tools are keyed by their credentialRef: ONE pod-wide tool per
    // distinct credential reference. This partial unique index makes the
    // connection→tool materialization race-safe (concurrent syncToolRows for the
    // same provider can't insert duplicates) and is scheme-agnostic — it covers
    // nango://, vault://, mcp://, and any future credentialed pod-wide tool.
    // Scoped to credential_ref IS NOT NULL + workspace_id IS NULL so it never
    // affects builtin/script tools (which legitimately carry NULL credentialRef)
    // or workspace-scoped tools (pod-wide identity only).
    podwideCredentialRefIdx: uniqueIndex("idx_tools_podwide_credential_ref")
      .on(table.credentialRef)
      .where(sql`credential_ref IS NOT NULL AND workspace_id IS NULL`),
  })
);

export type Tool = typeof tools.$inferSelect;
export type NewTool = typeof tools.$inferInsert;
export const insertToolSchema = createInsertSchema(tools);
export const selectToolSchema = createSelectSchema(tools);
