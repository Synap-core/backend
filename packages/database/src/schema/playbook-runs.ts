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
/**
 * Lifecycle of a run.
 *
 * `cancelled` is the RELEASE state: a live session that followed this playbook
 * stopped following it (`follow-playbook.ts`). It is neither `completed` (the
 * run did not finish) nor `failed` (nothing failed) — and the distinction is
 * load-bearing, because the scorecard feeds governance widening and a `failed`
 * row would grade a playbook for a person's change of mind.
 */
export type PlaybookRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "proposed"
  | "cancelled"
  // W2 calm: the reaper found the run quiet with its session still owing the
  // person an open slot — waiting on the human, never force-failed.
  | "waiting_on_you";

/** The normalized state of an external agent's task (the `status` verb). */
export type ExternalAgentState = "running" | "needs_input" | "done" | "failed";

/**
 * `playbook_runs.external_agent` — the run's external reference.
 * `status` is the dispatch lifecycle: `running` / `needs_input` keep the poll
 * going; `done` / `failed` / `cancelled` stop it.
 */
export interface PlaybookRunExternalAgent {
  agentUserId: string;
  toolId: string;
  provider: string;
  /** The provider's task id (from the `start` verb). */
  externalId: string | null;
  /** The provider's page for the task, when it gave one. */
  url: string | null;
  status: ExternalAgentState | "cancelled";
  /** The last normalized status read, as posted to the room (poll idempotency). */
  lastState?: {
    state: ExternalAgentState;
    url?: string;
    prUrl?: string;
    branch?: string;
    previewUrl?: string;
    summary?: string;
  };
  /** Fingerprint of `lastState` — the poll posts once per change. */
  lastStateKey?: string;
  polledAt?: string;
  /**
   * Set when the `status` verb came back PROPOSED (governance wants a person
   * to approve the read): polling pauses until that proposal is decided,
   * instead of filing one proposal per tick.
   */
  pollBlockedBy?: string;
  startedAt: string;
}

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
      enum: [
        "running",
        "completed",
        "failed",
        "proposed",
        "cancelled",
        "waiting_on_you",
      ],
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
    /**
     * The resolved playbook definition this run executed (D3c) —
     * { version, goalTemplate, stages, params, expectedOutputs }. Plain JSON
     * snapshot so "what ran" survives later edits to the playbook config.
     */
    definitionSnapshot: jsonb("definition_snapshot"),
    /** Soft self-reference to the run this one replays (schema support only). */
    replayOf: uuid("replay_of"),
    /**
     * The EXTERNAL agent this run was dispatched to (0315) — the receipt of
     * the hand-off, advanced by the status poll. NULL unless the
     * external-agent executor started a task through an agent binding.
     */
    externalAgent: jsonb("external_agent").$type<PlaybookRunExternalAgent>(),
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
