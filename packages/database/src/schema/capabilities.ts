/**
 * Capabilities Schema — a named bundle of what your agents can do.
 *
 * CONFIGURATION (not entity DATA). A Capability is a first-class CONTAINER —
 * "a thing your agents can do" — that groups a set of parts: Connections
 * (tools), Skills, and Built-ins. It owns nothing executable itself; its parts
 * attach via the polymorphic `links` table as
 *   `tool|skill|command --member_of--> capability`
 * (mirroring `automation --member_of--> playbook`). The capability detail is a
 * master/detail over those member links: a rail of parts + the selected part's
 * rich detail.
 *
 * Distinct from a Playbook: a Capability is the static bundle of what is
 * *possible*; a Playbook is a runnable *process* that draws on capabilities.
 * Part of the Playbooks & Capability Substrate
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
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const capabilities = pgTable(
  "capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Nullable = pod-wide (visible to all workspaces). */
    workspaceId: uuid("workspace_id"),
    /** Owning principal — human user id or agent-user id. */
    createdBy: text("created_by").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Per-capability approval gate. Born NOT approved (DEFAULT false) so an
     * AI-created bundle can't be treated as trusted until an owner approves it,
     * exactly like `tools.approved` / `mcp_servers.approved`.
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
    workspaceIdIdx: index("idx_capabilities_workspace_id").on(
      table.workspaceId
    ),
    createdByIdx: index("idx_capabilities_created_by").on(table.createdBy),
  })
);

export const insertCapabilitySchema = createInsertSchema(capabilities);
export const selectCapabilitySchema = createSelectSchema(capabilities);

export type CapabilityRow = typeof capabilities.$inferSelect;
export type NewCapabilityRow = typeof capabilities.$inferInsert;
