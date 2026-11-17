/**
 * THE process health rule — moved AS IT WAS from the browser's processors app
 * (`browser/electron/renderer/src/apps/processors/processes-model.ts`,
 * `deriveProcessHealth`, at browser origin/main 16 Nov 2026), so the pod's
 * process read (`readProcess` / `listProcesses`) and every surface wear ONE
 * derivation ("no surface forks a rule", start-here). The browser drops its
 * copy and imports this one (Process wave L4a).
 *
 * The input is STRUCTURAL: the run ledger's group facts (`runs.groups`, one
 * row per flow, exact over the whole ledger) and its bounded recent marks
 * (`runs.recentByFlows`). The browser's `RunGroup` / `RecentFlowRun` and the
 * pod's own `services/runs` rows both fit it. A date may arrive as a `Date`
 * (in process) or an ISO string (on the wire); both read the same.
 *
 * Changes from the browser copy, to make a leaf of it:
 *   - `isWaitingOnYou(status)` is read through the ONE unit-state derivation it
 *     already wrapped (`resolveRunUnitState(status).state === "needs_you"`,
 *     `@synap-core/web/run-detail`'s own body);
 *   - `kind` is optional: a Process is a playbook seen whole, and the rule
 *     never branched on it;
 *   - the words left the wire: a health carries a `reason` CODE (and, for
 *     `latest_unresolved`, the `latestStatus` it names), and a surface reads
 *     the label and the sentence through the vocabulary door.
 */
import { resolveRunUnitState, type UnitStateInput } from "../units/state.js";

/**
 * Every process health state, as a VALUE — the type is derived from it, so a
 * new state cannot exist without joining this list, and a scan over it (the
 * fleet's "every state lands in a group" test) sees the new state by existing.
 */
export const PROCESS_HEALTH_STATES = [
  "config-error",
  "unresolved-failure",
  "blocked-by-policy",
  "waiting-on-you",
  "running",
  "draft",
  "paused",
  "healthy",
  "never-run",
  "unknown",
] as const;
export type ProcessHealthState = (typeof PROCESS_HEALTH_STATES)[number];

/** The health states that need a person's attention now. */
export const PROCESS_ATTENTION_STATES: readonly ProcessHealthState[] = [
  "config-error",
  "unresolved-failure",
  "blocked-by-policy",
  "waiting-on-you",
];

/**
 * WHY a process has its health, as a structured code: the wire carries the
 * code, never words. A person reads it through the vocabulary door
 * (`resolveProcessHealthLabel` / `resolveProcessHealthReason`,
 * `@synap-core/types/vocabulary`, keys `vocabulary.processHealth.<code>.*`, en
 * + fr), so no surface hand-writes a health sentence. A value, so a new code
 * cannot exist without joining this list (the vocabulary's coverage floor
 * then refuses to build until it has words).
 */
export const PROCESS_HEALTH_REASONS = [
  "config_invalid",
  "running",
  "running_after_failure",
  "waiting_on_you",
  "blocked_by_policy",
  "latest_failed",
  "draft",
  "paused",
  "archived",
  "healthy",
  "latest_unresolved",
  "never_run",
  "not_enough_activity",
] as const;
export type ProcessHealthReason = (typeof PROCESS_HEALTH_REASONS)[number];

export interface ProcessHealth {
  state: ProcessHealthState;
  /** Why: the code a surface resolves to words (see PROCESS_HEALTH_REASONS). */
  reason: ProcessHealthReason;
  /**
   * `latest_unresolved` only: the latest run's status the reason names (a
   * token; the vocabulary resolves it). Absent otherwise.
   */
  latestStatus?: string | null;
  /** Run that explains the state, when the state is activity-derived. */
  runId: string | null;
  /**
   * `waiting-on-you` only: the focus session the waiting run drives — where
   * the owed slot lives, so the row's door opens it. Null when the pod did not
   * say (an automation run with no session, or a pod older than the field).
   */
  sessionId?: string | null;
}

/** A date as the ledger hands it: in process a `Date`, on the wire a string. */
export type ProcessDate = Date | string;

/** One run mark (`runs.recentByFlows` → `RecentFlowRun`), structurally. */
export interface ProcessRunMark {
  id: string;
  status: string;
  startedAt: ProcessDate;
  completedAt?: ProcessDate | null;
  /** The focus session the run drives, or null (absent on an older pod). */
  sessionId?: string | null;
}

/** The ledger's exact group facts for one flow (`runs.groups` → `RunGroup`), structurally. */
export interface ProcessRunGroup {
  runCount: number;
  latestRunId: string | null;
  latestStatus: string | null;
  latestStartedAt: ProcessDate | null;
  hasRunning: boolean;
  completedCount?: number;
  failedCount?: number;
  /** Runs that FAILED within the last 7 days (the health number). */
  recentFailedCount?: number;
  runningCount?: number;
}

export interface ProcessHealthInput {
  /** Legacy (the browser's `ProcessKind`); the rule never branches on it. */
  kind?: "automation" | "playbook";
  /** The playbook's (or automation's) own status: draft, active, paused, archived, error. */
  definitionStatus: string;
  runGroup: ProcessRunGroup | null;
  recentRuns: readonly ProcessRunMark[];
  /** Exact server-side total, or null when the grouped result is incomplete. */
  exactRunCount: number | null;
}

/** A run the reaper parked because its session still owes the person. */
export function isWaitingOnYouRun(status: string): boolean {
  return resolveRunUnitState(status).state === "needs_you";
}

/**
 * The session a run mark drives (`runs.recentByFlows` → `RecentFlowRun.
 * sessionId`). Read STRUCTURALLY: a pod older than the field omits it — read
 * as null (no session door), never as a guess.
 */
export function sessionIdOfRunMark(
  runs: readonly ProcessRunMark[],
  runId: string
): string | null {
  const mark = runs.find((r) => r.id === runId) as
    { sessionId?: unknown } | undefined;
  const id = mark?.sessionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

const time = (d: ProcessDate): number => new Date(d).getTime();

const successfulOutcome = (status: string): boolean =>
  status === "completed" || status === "skipped";

const newestFirst = (a: ProcessRunMark, b: ProcessRunMark): number =>
  time(b.startedAt) - time(a.startedAt);

interface ProcessRunEvidence {
  id: string;
  status: string;
  startedAt: Date;
}

function groupEvidence(
  runGroup: ProcessRunGroup | null
): ProcessRunEvidence | null {
  if (
    !runGroup?.latestRunId ||
    !runGroup.latestStatus ||
    !runGroup.latestStartedAt
  ) {
    return null;
  }
  return {
    id: runGroup.latestRunId,
    status: runGroup.latestStatus,
    startedAt: new Date(runGroup.latestStartedAt),
  };
}

function newestEvidence(
  runGroup: ProcessRunGroup | null,
  recentRuns: readonly ProcessRunMark[],
  accepts: (status: string) => boolean = () => true
): ProcessRunEvidence | null {
  const recent = [...recentRuns]
    .sort(newestFirst)
    .find((run) => accepts(run.status));
  const grouped = groupEvidence(runGroup);
  const acceptedGroup = grouped && accepts(grouped.status) ? grouped : null;

  if (!recent) return acceptedGroup;
  if (!acceptedGroup) {
    return {
      id: recent.id,
      status: recent.status,
      startedAt: new Date(recent.startedAt),
    };
  }
  // The grouped endpoint is the server's exact latest summary. It wins ties
  // and any disagreement at the same timestamp; bounded recent history only
  // wins when it carries demonstrably newer evidence.
  return acceptedGroup.startedAt.getTime() >= time(recent.startedAt)
    ? acceptedGroup
    : {
        id: recent.id,
        status: recent.status,
        startedAt: new Date(recent.startedAt),
      };
}

/**
 * Actionable health is about what needs attention now, not lifetime success
 * rate. The precedence is product policy and intentionally explicit.
 */
export function deriveProcessHealth(input: ProcessHealthInput): ProcessHealth {
  const { definitionStatus, runGroup, recentRuns, exactRunCount } = input;
  const latest = newestEvidence(runGroup, recentRuns);
  const latestNonRunning = newestEvidence(
    runGroup,
    recentRuns,
    (status) => status !== "running"
  );

  if (definitionStatus === "error") {
    return {
      state: "config-error",
      reason: "config_invalid",
      runId: null,
    };
  }

  const hasRunning =
    runGroup?.hasRunning === true ||
    recentRuns.some((run) => run.status === "running");
  if (hasRunning) {
    const running = newestEvidence(
      runGroup,
      recentRuns,
      (status) => status === "running"
    );
    const previousFailed = latestNonRunning?.status === "failed";
    return {
      state: "running",
      reason: previousFailed ? "running_after_failure" : "running",
      runId: running?.id ?? null,
    };
  }

  // W2 calm: the reaper parked the latest run because its session still owes
  // the person. It is YOUR TURN — its own state, never a failure and never the
  // "unresolved" shrug it fell into before.
  if (latest && isWaitingOnYouRun(latest.status)) {
    return {
      state: "waiting-on-you",
      reason: "waiting_on_you",
      runId: latest.id,
      sessionId: sessionIdOfRunMark(recentRuns, latest.id),
    };
  }

  if (latest?.status === "failed" || latest?.status === "blocked_by_policy") {
    // A governance policy-block still needs a human's eye, so it stays a
    // needs-attention state — but its OWN state (calm ochre, not the red of a
    // real failure): policy said no, nothing broke.
    const isBlocked = latest.status === "blocked_by_policy";
    return {
      state: isBlocked ? "blocked-by-policy" : "unresolved-failure",
      reason: isBlocked ? "blocked_by_policy" : "latest_failed",
      runId: latest.id,
    };
  }

  if (definitionStatus === "draft") {
    return {
      state: "draft",
      reason: "draft",
      runId: null,
    };
  }

  if (definitionStatus === "paused" || definitionStatus === "archived") {
    return {
      state: "paused",
      reason: definitionStatus === "archived" ? "archived" : "paused",
      runId: null,
    };
  }

  if (latest && successfulOutcome(latest.status)) {
    return {
      state: "healthy",
      reason: "healthy",
      runId: latest.id,
    };
  }

  if (latest) {
    return {
      state: "unknown",
      reason: "latest_unresolved",
      latestStatus: latest.status,
      runId: latest.id,
    };
  }

  if (exactRunCount === 0) {
    return {
      state: "never-run",
      reason: "never_run",
      runId: null,
    };
  }

  return {
    state: "unknown",
    reason: "not_enough_activity",
    runId: runGroup?.latestRunId ?? null,
  };
}

/** Whether a health state needs a person's attention now. */
export function processHealthNeedsAttention(
  health: Pick<ProcessHealth, "state">
): boolean {
  return PROCESS_ATTENTION_STATES.includes(health.state);
}

/**
 * The ONE tone of a process health: its state as the unit-state input every
 * surface draws with `resolveUnitState` (the desktop's `UnitMark`, pod admin's
 * pill). Presentation of the rule above, kept beside it so the desktop and pod
 * admin never map a health state to a mark twice (Process wave plan 0adf8352
 * W4). Total over `PROCESS_HEALTH_STATES` (the switch has no default: a new
 * state does not compile until it is mapped).
 *
 *   config-error / unresolved-failure → failed (it broke; the owner must fix it)
 *   blocked-by-policy                 → checkGate (policy said no: a person's
 *                                        eye, calm, never the red of a failure)
 *   waiting-on-you                    → waitingOnYou (your turn)
 *   running                           → running
 *   draft / never-run                 → everStarted: false (nothing yet)
 *   paused                            → idle (the quiet paused mark)
 *   healthy                           → terminal (the calm success mark: its
 *                                        last outcome is done and nothing is
 *                                        owed; a surface names it with
 *                                        `resolveStatusLabel(health.state)`)
 *   unknown                           → unreadable (unmeasured is never calm)
 */
export function processHealthUnitInput(
  health: Pick<ProcessHealth, "state">
): UnitStateInput {
  switch (health.state) {
    case "config-error":
    case "unresolved-failure":
      return { failed: true };
    case "blocked-by-policy":
      return { checkGate: true };
    case "waiting-on-you":
      return { waitingOnYou: true };
    case "running":
      return { running: true };
    case "draft":
    case "never-run":
      return { everStarted: false };
    case "paused":
      return { idle: true };
    case "healthy":
      return { terminal: true };
    case "unknown":
      return { unreadable: true };
  }
}
