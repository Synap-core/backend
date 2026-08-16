/**
 * Projects Schema
 *
 * User projects for organizing threads and entities.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const projects = pgTable(
  "projects",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Context
    userId: text("user_id").notNull(),
    // Nullable for pod-wide projects.
    workspaceId: uuid("workspace_id"),

    // Project info
    name: text("name").notNull(),
    description: text("description"),

    /**
     * Cross-pod addressable ref (P4-lite W0). Generated from `name` by the ONE
     * slugify door (`slugifyProjectName` in utils/project-slug.ts), unique per
     * user (partial index below), mirrored to the CP `pod_projects` directory.
     * Nullable: legacy rows are backfilled by migration 0200.
     */
    slug: text("slug"),

    // Status
    status: text("status", {
      enum: ["active", "archived", "completed"],
    })
      .notNull()
      .default("active"),
    /**
     * Where this engagement is in its own lifecycle (migration 0240) — the
     * before/during/after state a months-long piece of work moves through.
     *
     * Distinct from `status`, which is the ROW's lifecycle (active / archived /
     * completed). `phase` is the WORK's lifecycle and is user-defined: a
     * consulting engagement, a marketing campaign and a product launch each name
     * their phases differently, so this is free text rather than an enum and the
     * vocabulary lives in config.
     *
     * Progress is rolled up from contained work — never a percentage invented for
     * something with no end date. The phase plus a human-written update is the
     * health signal.
     */
    phase: text("phase"),

    // Settings (agent preferences, defaults, etc.)
    settings: jsonb("settings"),
    metadata: jsonb("metadata"),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("projects_user_id_idx").on(table.userId),
    statusIdx: index("projects_status_idx").on(table.status),
    userSlugUniq: uniqueIndex("projects_user_slug_uniq")
      .on(table.userId, table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
  })
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
