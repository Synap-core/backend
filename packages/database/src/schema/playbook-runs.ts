/**
 * Playbook Runs Schema — the run ledger (executor spine, Phase 3)
 *
 * RUNTIME (not config, not entity DATA). A playbook_run is one execution of a
 * Playbook: created when `runPlaybook` dispatches a playbook to its executor
 * (`is-agent` | `external-agent` | `hybrid`). It links the config (`playbook_id`)
 * to the runtime (`session_id`) and records status/summary/error as the executor
 * reports back (capture-back via the Hub `POST /runs/:id/capture` route).
 *
 * Part of the Playbooks & Capability Substrate
 * (team/platform/playbooks-capability-substrate.mdx §4.3-4.4).
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

/** Which "hands" ran this. Mirrors @synap/playbooks ExecutorRef. */
export type PlaybookRunExecutorRef = "is-agent" | "external-agent" | "hybrid";
/** Lifecycle of a run. */
export type PlaybookRunStatus = "running" | "completed" | "failed" | "proposed";

export const playbookRuns = pgTable(
  "playbook_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Nullable = pod-wide run (playbook with no workspace). */
    workspaceId: uuid("workspace_id"),
    /** The config this run instantiated (FK playbooks, cascade on delete). */
    playbookId: uuid("playbook_id").notNull(),
    /** The runtime session this run drives (FK focus_sessions, set-null on delete). */
    sessionId: uuid("session_id"),
    executor: text("executor", {
      enum: ["is-agent", "external-agent", "hybrid"],
    })
      .$type<PlaybookRunExecutorRef>()
      .notNull(),
    status: text("status", {
      enum: ["running", "completed", "failed", "proposed"],
    })
      .$type<PlaybookRunStatus>()
      .notNull()
      .default("running"),
    /** The resolved params/input this run was started with. */
    input: jsonb("input").notNull().default({}),
    /** Executor-reported summary on completion. */
    summary: text("summary"),
    /** Executor-reported error on failure. */
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Owning principal — human user id or agent-user id. */
    createdBy: text("created_by").notNull(),
  },
  (table) => ({
    playbookIdIdx: index("idx_playbook_runs_playbook_id").on(table.playbookId),
    sessionIdIdx: index("idx_playbook_runs_session_id").on(table.sessionId),
    workspaceStatusIdx: index("idx_playbook_runs_workspace_status").on(
      table.workspaceId,
      table.status
    ),
  })
);

export type PlaybookRun = typeof playbookRuns.$inferSelect;
export type NewPlaybookRun = typeof playbookRuns.$inferInsert;
export const insertPlaybookRunSchema = createInsertSchema(playbookRuns);
export const selectPlaybookRunSchema = createSelectSchema(playbookRuns);
