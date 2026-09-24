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
  smallint,
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
    /**
     * When this project is AIMED at (migration 0252). The one field that lets a
     * long-horizon object go red: with no date a project can only ever be green,
     * which is how goal layers die quietly.
     *
     * Nullable, and that is a statement rather than a default: an undated project
     * is not late, it is UNDATED. (It also keeps the Control Plane's `pod_projects`
     * mirror — "an accelerator, never an authority" — working unchanged; its sync
     * selects an explicit column list and never sees this.)
     *
     * There is deliberately no `progress` or `health` column beside it. Both are
     * DERIVED — progress from the contained work, health from this date against
     * now() — for the same reason `phase` records above: a stored percentage is a
     * number nobody recomputes.
     */
    targetDate: timestamp("target_date", { mode: "date", withTimezone: true }),

    /**
     * The project's colour, as a SLOT 1–12 in the identity palette
     * (`--synap-identity-N`), never a hex — the palette has a light and a dark
     * value per slot, so a slot is right on both themes (0271). NULL = the
     * person has not chosen one; surfaces then derive a slot from the id.
     */
    colorSlot: smallint("color_slot"),

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
