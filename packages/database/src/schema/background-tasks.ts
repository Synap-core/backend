/**
 * Background Tasks Schema
 *
 * Scheduled tasks for proactive AI analysis and automation.
 * Task definitions are stored in the backend, executed in the Intelligence Service.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const backgroundTasks = pgTable(
  "background_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),

    // Task Definition
    name: text("name").notNull(),
    description: text("description"),
    type: text("type", {
      enum: ["cron", "event", "interval"],
    }).notNull(),

    // Schedule (type-specific)
    schedule: text("schedule"), // Cron expression, event pattern, or interval (e.g., "1h", "30m")
    // For cron: "0 9 * * *" (daily at 9 AM)
    // For event: "entities.created.completed" (triggered by event)
    // For interval: "1h" (every hour)

    // Action
    action: text("action").notNull(), // Action to execute (e.g., "proactive_analysis", "pattern_detection")
    context: jsonb("context").default("{}").notNull(), // Additional context for the action

    // Status
    status: text("status", {
      enum: ["active", "paused", "error"],
    })
      .notNull()
      .default("active"),
    errorMessage: text("error_message"), // Last error if status is 'error'

    // Execution Tracking
    lastRunAt: timestamp("last_run_at", { mode: "date", withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { mode: "date", withTimezone: true }),
    executionCount: integer("execution_count").default(0).notNull(),
    successCount: integer("success_count").default(0).notNull(),
    failureCount: integer("failure_count").default(0).notNull(),

    // Metadata
    metadata: jsonb("metadata").default("{}").notNull(),
    // {
    //   averageExecutionTime: 150,
    //   lastResult: { success: true, proposalsGenerated: 3 },
    //   tags: ['analysis', 'proactive']
    // }

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("background_tasks_user_id_idx").on(table.userId),
    workspaceIdIdx: index("background_tasks_workspace_id_idx").on(
      table.workspaceId
    ),
    statusIdx: index("background_tasks_status_idx").on(table.status),
    typeIdx: index("background_tasks_type_idx").on(table.type),
    nextRunAtIdx: index("background_tasks_next_run_at_idx").on(table.nextRunAt),
  })
);

export type BackgroundTask = typeof backgroundTasks.$inferSelect;
export type NewBackgroundTask = typeof backgroundTasks.$inferInsert;

// Zod Schemas
export const insertBackgroundTaskSchema = createInsertSchema(backgroundTasks);
export const selectBackgroundTaskSchema = createSelectSchema(backgroundTasks);
