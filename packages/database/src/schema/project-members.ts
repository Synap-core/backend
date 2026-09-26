/**
 * Project Members Schema
 *
 * Provides project-level access control within workspaces.
 * A user can be in a workspace but only have access to specific projects.
 *
 * project_id references projects(id) — projects are now table-based (not entities).
 * Migration 0151 consolidates projects from entity-based to table-based.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Relationships
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),

    // Role in this specific project
    // Uses same roles as workspace for consistency
    // 'owner' | 'editor' | 'viewer' | 'guest'. A GUEST sees only what is
    // explicitly shared with the project (`visible_to`), never edits (not in
    // PROJECT_WRITE_ROLES). The set is enforced in zod, not a CHECK.
    role: text("role").notNull().default("viewer"),

    // The link (`resource_shares.id`) a guest membership was redeemed through
    // (0276). The FK (ON DELETE SET NULL) lives in SQL only, to avoid a schema
    // import cycle.
    grantedViaShareId: uuid("granted_via_share_id"),

    // Metadata
    invitedBy: text("invited_by"), // Who added them to this project
    invitedAt: timestamp("invited_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Unique: one role per user per project
    uniqueProjectUser: unique("project_user_unique").on(
      table.projectId,
      table.userId
    ),
    // Indexes for fast lookups
    projectIdx: index("idx_project_members_project").on(table.projectId),
    userIdx: index("idx_project_members_user").on(table.userId),
    userProjectIdx: index("idx_project_members_user_project").on(
      table.userId,
      table.projectId
    ),
  })
);

// Type exports
export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertProjectMemberSchema = createInsertSchema(projectMembers);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectProjectMemberSchema = createSelectSchema(projectMembers);
