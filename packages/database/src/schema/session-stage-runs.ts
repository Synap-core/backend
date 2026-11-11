/**
 * SESSION STAGE RUNS (0422) — one row per time a step of a playbook run is
 * ENTERED: who works it, on which computer, whether it waits on tools or on a
 * child run, and when it ended (runner engine slice 3, spec 7111934d §5;
 * decision D4: a row for EVERY stage entry of every run, not only the ones
 * with a runner, so a screen reads ONE source for "who is on it now" and
 * "who did each step").
 *
 * Written only by the stage runner (`enterStage`, @synap/api
 * `services/playbooks/stage-runner.ts`). Owner-private through the session's
 * owner floor, like `focus_sessions`: no workspace column of its own.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import type { PlaybookRunExternalAgent } from "./playbook-runs.js";

/**
 * running        the step is being worked (by `runnerAgentUserId`, NULL =
 *                Synap AI);
 * waiting_tools  its runner's computer lacks a tool it needs: an install was
 *                asked for, the step waits;
 * waiting_child  the step IS a playbook (`uses`): a child run works it
 *                (slice 4);
 * waiting_start  its agent is bound for dispatch and starting its provider
 *                task waits for the person's approval (governance);
 * unreached      its agent is bound for dispatch and the step did not reach
 *                it (the start or the send failed): never "running" over a
 *                delivery nothing received;
 * done / failed / cancelled  it ended.
 */
export const SESSION_STAGE_RUN_STATUSES = [
  "running",
  "waiting_tools",
  "waiting_child",
  "waiting_start",
  "unreached",
  "done",
  "failed",
  "cancelled",
] as const;
export type SessionStageRunStatus = (typeof SESSION_STAGE_RUN_STATUSES)[number];

/** The statuses of a step that has not ended. */
export const OPEN_STAGE_RUN_STATUSES = [
  "running",
  "waiting_tools",
  "waiting_child",
  "waiting_start",
  "unreached",
] as const;

/**
 * How the step's runner was decided:
 *   entered     named when the step was entered (`stageRunner`);
 *   run_choice  the run's own choice for that step (`stageRunners[key]`);
 *   stage       the runner the step names (`PlaybookStage.runner`);
 *   self        nobody else named: the run's own agent.
 */
export const STAGE_RUNNER_VIAS = [
  "entered",
  "run_choice",
  "stage",
  "self",
] as const;
export type StageRunnerVia = (typeof STAGE_RUNNER_VIAS)[number];

export const sessionStageRuns = pgTable(
  "session_stage_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id").notNull(),
    /** The run the step belongs to; NULL for a session with no run row. */
    playbookRunId: uuid("playbook_run_id"),
    stageKey: text("stage_key").notNull(),
    /** 1 on the first entry; a re-entry (an `onFail` return) adds one. */
    attempt: integer("attempt").notNull().default(1),
    /** The agent working it; NULL = Synap AI (or nobody could take it). */
    runnerAgentUserId: text("runner_agent_user_id"),
    runnerVia: text("runner_via", { enum: STAGE_RUNNER_VIAS }).notNull(),
    presetKey: text("preset_key"),
    /** The runner's computer (`users.host_user_id`) when it was handed the step. */
    computerUserId: text("computer_user_id"),
    /** The child run's session, for a step that IS a playbook (slice 4). */
    childSessionId: uuid("child_session_id"),
    /**
     * The provider task the step was sent to, when its agent is bound for
     * dispatch (the run hand-off's shape, `PlaybookRunExternalAgent`): the
     * task started for the step, or the run's live task it was sent into.
     */
    externalAgent: jsonb("external_agent").$type<PlaybookRunExternalAgent>(),
    status: text("status", { enum: SESSION_STAGE_RUN_STATUSES })
      .notNull()
      .default("running"),
    /** Per required tool: installed | missing | unverified, + the install ask. */
    requiresReport: jsonb("requires_report"),
    /** Each runner choice passed over, and why (`RunnerPassedOver[]`). */
    passedOver: jsonb("passed_over"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => ({
    sessionStageIdx: index("session_stage_runs_session_stage_idx").on(
      table.sessionId,
      table.stageKey
    ),
  })
);

export type SessionStageRun = typeof sessionStageRuns.$inferSelect;
export type NewSessionStageRun = typeof sessionStageRuns.$inferInsert;
