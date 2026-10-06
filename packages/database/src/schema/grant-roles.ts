/**
 * Grant roles — a person's reusable, named permission lists (2026-10-06).
 *
 * A role is `{ name, description, grant }`: the same shape as the built-in
 * presets in `@synap-core/types/grants` (`GrantRole`), so a selector shows
 * presets and stored roles alike. It is NOT the profile "role" (a facet like
 * client / investor) and NOT a workspace member role.
 *
 * A role is a TEMPLATE, never a live binding: minting a key from a role copies
 * the role's grant onto the key's `grants` row and stamps `grants.role_id` as
 * lineage. Editing a role therefore never widens a key that already exists —
 * a change in reach is always a fresh, visible mint.
 *
 *   permissions       — the grant grammar (`entity.knowledge.read`, `*`).
 *   *_ids             — NULL = the role does not narrow on that axis.
 *   expires_in_days   — the lifetime it sets; NULL = it sets none (the key
 *                       keeps the mint default) unless `never_expires`.
 *
 * ONE write door: `GrantRoleRepository`.
 */

import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const grantRoles = pgTable(
  "grant_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The person who owns the role. */
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    permissions: text("permissions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    workspaceIds: uuid("workspace_ids").array(),
    projectIds: uuid("project_ids").array(),
    entityIds: uuid("entity_ids").array(),
    expiresInDays: integer("expires_in_days"),
    neverExpires: boolean("never_expires").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("grant_roles_user_idx").on(t.userId),
  })
);

export type GrantRoleRecord = typeof grantRoles.$inferSelect;
export type GrantRoleInsert = typeof grantRoles.$inferInsert;
