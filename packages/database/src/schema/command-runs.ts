/**
 * Command Runs Schema
 *
 * Audit / operational log for command executions.
 * Every run has a thread_id (provenance); permissions_snapshot preserves command state at run time.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-threads.js";
import { intelligenceCommands } from "./intelligence-commands.js";

export const commandRuns = pgTable(
  "command_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    commandId: uuid("command_id")
      .notNull()
      .references(() => intelligenceCommands.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: text("user_id").notNull(),

    /** Snapshot of command permissions at run time */
    permissionsSnapshot: jsonb("permissions_snapshot").$type<
      Record<string, unknown>
    >(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>(),
    selectionContextSnapshot: jsonb(
      "selection_context_snapshot"
    ).$type<unknown>(),
    outputSummary: text("output_summary"),
    proposedActions: jsonb("proposed_actions").$type<unknown[]>(),
    approvedActions: jsonb("approved_actions").$type<unknown[]>(),

    status: text("status", {
      enum: ["running", "completed", "failed"],
    })
      .notNull()
      .default("running"),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    errorMessage: text("error_message"),
  },
  (table) => ({
    commandIdIdx: index("command_runs_command_id_idx").on(table.commandId),
    workspaceIdIdx: index("command_runs_workspace_id_idx").on(
      table.workspaceId
    ),
    userIdIdx: index("command_runs_user_id_idx").on(table.userId),
    threadIdIdx: index("command_runs_thread_id_idx").on(table.threadId),
    startedAtIdx: index("command_runs_started_at_idx").on(table.startedAt),
  })
);

export type CommandRun = typeof commandRuns.$inferSelect;
export type NewCommandRun = typeof commandRuns.$inferInsert;
