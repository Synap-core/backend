/**
 * `@synap-core/types/workers/health` — how a goal's workers are DOING, as ONE
 * derivation every surface reads (goals that run, plan 1ad1cecc).
 *
 * A goal's "how it runs" is its workers (`workers.list({ trackId })`). Each
 * worker row carries its health, read by the pod from the worker's own
 * automation runs, never recomputed on a page:
 *
 *   marks                 the last {@link RUN_HEALTH_MARK_LIMIT} runs, oldest →
 *                         newest, each a {@link RunMark};
 *   consecutiveFailures   failures since the last success (a skipped or held
 *                         run neither breaks nor heals the streak, as the
 *                         automation breaker counts it);
 *   state                 ONE {@link RunHealthState} ({@link deriveRunHealth}).
 *
 * The goal's own reading is {@link goalRunHealth} over its workers. A tone or
 * a glyph comes from the shared unit-state door through
 * {@link runHealthUnitInput} → `resolveUnitState` — never a colour here.
 *
 * Imports one TYPE only, so it stays as light as the `./workers` leaf.
 */
import type { UnitStateInput } from "../units/state.js";
import type {
  WorkerActivator,
  WorkerMode,
  WorkerScopeKind,
  WorkerSize,
} from "./index.js";

// ── Run marks ───────────────────────────────────────────────────────────────

/**
 * What one run of a worker came to.
 *
 *   done     — it finished.
 *   failed   — it ran and did not work.
 *   waiting  — it waits on a person (its session still owes you an answer).
 *   skipped  — it fired and did nothing: a dedup, a daily cap, a backlog of
 *              approvals, a rule said no, a person cancelled it, or it stopped
 *              at its budget. Not a failure.
 *   running  — it is in flight now.
 */
export const RUN_MARKS = [
  "done",
  "failed",
  "waiting",
  "skipped",
  "running",
] as const;
export type RunMark = (typeof RUN_MARKS)[number];

/** How many runs a health strip shows (the newest ones). */
export const RUN_HEALTH_MARK_LIMIT = 10;

/**
 * A run's stored status (`automation_runs.status`) and stop reason as a mark.
 * A `failed` run that only stopped at its budget (`stop_reason = 'budget'`) is
 * `skipped`, exactly as the breaker leaves it out of the streak. An unknown
 * status is null: the strip omits it rather than guessing.
 */
export function runMarkOfRunStatus(
  status: string | null | undefined,
  stopReason?: string | null
): RunMark | null {
  switch (status) {
    case "completed":
    case "success":
      return "done";
    case "failed":
      return stopReason === "budget" ? "skipped" : "failed";
    case "waiting_on_you":
      return "waiting";
    case "skipped":
    case "blocked_by_policy":
    case "cancelled":
      return "skipped";
    case "running":
    case "pending":
    case "queued":
      return "running";
    default:
      return null;
  }
}

export interface RunMarkEntry {
  /** The run (`automation_runs.id`) — its door. */
  runId: string;
  mark: RunMark;
  /** ISO time the run started. */
  at: string;
}

/**
 * Failures since the last success, read newest → oldest: `failed` extends the
 * streak, `done` ends it, every other mark is passed over (the breaker's
 * `STREAK_STATUSES`: only a real success heals, only a real failure breaks).
 */
export function consecutiveFailuresOf(
  marksOldestFirst: readonly { mark: RunMark }[]
): number {
  let n = 0;
  for (let i = marksOldestFirst.length - 1; i >= 0; i--) {
    const m = marksOldestFirst[i]!.mark;
    if (m === "done") break;
    if (m === "failed") n++;
  }
  return n;
}

// ── Health ──────────────────────────────────────────────────────────────────

/**
 * ONE state per worker, and per goal ({@link goalRunHealth}).
 *
 *   failing      — it is on and its last settled run failed.
 *   off          — the pod turned it off: the breaker stopped its automation
 *                  after failures in a row ({@link GOAL_WORKER_FAILURE_LIMIT}).
 *                  Fix it, then resume it.
 *   waiting      — it is on and runs wait on a person (approvals, answers).
 *   healthy      — it is on and nothing is wrong (no run yet is healthy too).
 *   paused       — a person paused it.
 *   not_running  — it is on but nothing fires it (no live automation), or a
 *                  goal that has no worker at all.
 */
export const RUN_HEALTH_STATES = [
  "failing",
  "off",
  "waiting",
  "healthy",
  "paused",
  "not_running",
] as const;
export type RunHealthState = (typeof RUN_HEALTH_STATES)[number];

export interface RunHealth {
  state: RunHealthState;
  /** The newest runs, oldest → newest, at most {@link RUN_HEALTH_MARK_LIMIT}. */
  marks: RunMarkEntry[];
  consecutiveFailures: number;
  /** Why it is `off` (the breaker's sentence); null otherwise. */
  offReason: string | null;
}

/**
 * Failures in a row after which a goal's worker is turned off (founder,
 * goals-that-run decision 7). Read by the automation breaker for an
 * automation that runs a worker filed into a goal; every other automation
 * keeps the breaker's own limit.
 */
export const GOAL_WORKER_FAILURE_LIMIT = 3;

/**
 * THE health derivation. Order is the rule: a person's pause first (it says
 * why nothing runs), then the pod's stop, then a failure, then your turn.
 */
export function deriveRunHealth(input: {
  /** The enablement is paused (its rule is a draft). */
  paused: boolean;
  /**
   * The status of the worker's automation (`automations.status`); null when
   * the enablement has no automation (nothing compiled, or a manual worker).
   */
  automationStatus: string | null;
  /** The breaker's sentence (`automations.error_message`), when it stopped. */
  automationError?: string | null;
  /** The newest runs, OLDEST first (callers cap at the mark limit). */
  marks: readonly RunMarkEntry[];
  /** Runs waiting on a person's approval (`workers.list` pendingApprovals). */
  pendingApprovals: number;
}): RunHealth {
  const marks = input.marks.slice(-RUN_HEALTH_MARK_LIMIT);
  const consecutiveFailures = consecutiveFailuresOf(marks);
  const base = { marks, consecutiveFailures, offReason: null };
  if (input.paused) return { state: "paused", ...base };
  if (input.automationStatus === "error") {
    return {
      state: "off",
      ...base,
      offReason: input.automationError?.trim() || null,
    };
  }
  if (input.automationStatus !== "active") {
    return { state: "not_running", ...base };
  }
  if (consecutiveFailures > 0) return { state: "failing", ...base };
  const last = marks[marks.length - 1]?.mark;
  if (input.pendingApprovals > 0 || last === "waiting") {
    return { state: "waiting", ...base };
  }
  return { state: "healthy", ...base };
}

/**
 * Worst first: what a goal shows when its workers disagree. A failure outranks
 * your turn (silence there is expensive), your turn outranks calm, and a goal
 * whose every worker is paused reads paused. No worker → `not_running`.
 */
const GOAL_HEALTH_ORDER: readonly RunHealthState[] = [
  "failing",
  "off",
  "waiting",
  "healthy",
  "not_running",
  "paused",
];

/** The goal's ONE health state, rolled up from its workers. */
export function goalRunHealth(
  workers: readonly { health: Pick<RunHealth, "state"> }[]
): RunHealthState {
  if (workers.length === 0) return "not_running";
  let best = GOAL_HEALTH_ORDER.length - 1;
  for (const w of workers) {
    const i = GOAL_HEALTH_ORDER.indexOf(w.health.state);
    if (i >= 0 && i < best) best = i;
  }
  return GOAL_HEALTH_ORDER[best]!;
}

/**
 * The health state as the SHARED unit input, so its tone and glyph come from
 * `resolveUnitState` like every other unit of work: failing and off read
 * `failed`, waiting `needs_review` (approvals are a judgement), healthy
 * `scheduled` (it waits for its trigger), paused `paused`, not running
 * `not_started`.
 */
export function runHealthUnitInput(state: RunHealthState): UnitStateInput {
  switch (state) {
    case "failing":
    case "off":
      return { failed: true };
    case "waiting":
      return { pendingDecisions: 1 };
    case "healthy":
      return { schedule: { cron: "", enabled: true } };
    case "paused":
      return { schedule: { cron: "", enabled: false } };
    case "not_running":
      return { everStarted: false };
  }
}

// ── The goal's worker, as the pages read it ────────────────────────────────

/** What wakes a worker, in its kind: a clock, something happening, a button. */
export const WORKER_TRIGGER_KINDS = ["schedule", "event", "manual"] as const;
export type WorkerTriggerKind = (typeof WORKER_TRIGGER_KINDS)[number];

/** The trigger kind of an activator trigger. */
export function workerTriggerKind(
  on: WorkerActivator["on"] | null | undefined
): WorkerTriggerKind {
  if (on === "schedule") return "schedule";
  if (on === "manual" || !on) return "manual";
  return "event";
}

export interface WorkerTriggerView {
  kind: WorkerTriggerKind;
  /**
   * The trigger in plain words, from the pod (`workerWhen`: a schedule reads
   * through `cronWords`, never a raw cron). Null when it cannot be said.
   */
  words: string | null;
}

/**
 * ONE enabled worker as `workers.list` returns it — the goal page's "How it
 * runs" row, the Goals list's rhythm and health, pod admin's inventory.
 * Every field is the pod's: `nextRunAt` is read off the worker's automation,
 * never computed on a page.
 */
export interface GoalWorkerView {
  /** The enablement (its governed rule): what pause / resume act on. */
  ruleId: string;
  playbookId: string;
  playbookName: string;
  activatorKey: string;
  /** The declared activator; null when the playbook no longer declares it. */
  activator: (WorkerActivator & { mode: WorkerMode }) | null;
  profileSlug: string | null;
  size: WorkerSize;
  /** Approval mode: `propose` asks a person before each run, `run` acts. */
  mode: WorkerMode;
  scope: WorkerScopeKind;
  projectId: string | null;
  /** The goal it serves (`project_tracks.id`); null for a project or space one. */
  trackId: string | null;
  /** `paused` = a person paused it. */
  state: "running" | "paused";
  /** The automation that fires it (null while paused or turned off). */
  automationId: string | null;
  pendingApprovals: number;
  maxPendingApprovals: number;
  trigger: WorkerTriggerView;
  /** ISO time of its last run; null = never ran. */
  lastRunAt: string | null;
  /** ISO time of its next scheduled run; null = not on a clock, or off. */
  nextRunAt: string | null;
  health: RunHealth;
}
