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
 * Only two changes from the browser copy, both to make a leaf of it:
 *   - `isWaitingOnYou(status)` is read through the ONE unit-state derivation it
 *     already wrapped (`resolveRunUnitState(status).state === "needs_you"`,
 *     `@synap-core/web/run-detail`'s own body);
 *   - `kind` is optional: a Process is a playbook seen whole, and the rule
 *     never branched on it.
 */
import { resolveStatusLabel } from "../vocabulary/index.js";
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

export interface ProcessHealth {
  state: ProcessHealthState;
  label: string;
  reason: string;
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
      label: "Configuration error",
      reason: "The saved definition is invalid or cannot be activated.",
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
      label: previousFailed ? "Running · previous run failed" : "Running",
      reason: previousFailed
        ? "An execution is in progress after the previous known outcome failed."
        : "At least one execution is currently in progress.",
      runId: running?.id ?? null,
    };
  }

  // W2 calm: the reaper parked the latest run because its session still owes
  // the person. It is YOUR TURN — its own state, never a failure and never the
  // "unresolved" shrug it fell into before.
  if (latest && isWaitingOnYouRun(latest.status)) {
    return {
      state: "waiting-on-you",
      label: resolveStatusLabel("waiting_on_you"),
      reason:
        "The latest run is paused until you answer what its session asked of you.",
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
      label: isBlocked ? "Blocked by policy" : "Latest run failed",
      reason: isBlocked
        ? "Governance refused the latest run’s effect — it needs your review."
        : "No newer successful outcome resolves the latest failure.",
      runId: latest.id,
    };
  }

  if (definitionStatus === "draft") {
    return {
      state: "draft",
      label: "Draft",
      reason: "The definition still needs to be completed or activated.",
      runId: null,
    };
  }

  if (definitionStatus === "paused" || definitionStatus === "archived") {
    return {
      state: "paused",
      label: definitionStatus === "archived" ? "Archived" : "Paused",
      reason:
        definitionStatus === "archived"
          ? "The definition is archived and will not start new runs."
          : "The definition is paused and will not start new runs.",
      runId: null,
    };
  }

  if (latest && successfulOutcome(latest.status)) {
    return {
      state: "healthy",
      label: "Healthy",
      reason: "The latest known outcome completed without failure.",
      runId: latest.id,
    };
  }

  if (latest) {
    return {
      state: "unknown",
      label: "Latest status unresolved",
      reason: `The latest execution is ${latest.status}; Synap cannot classify it as healthy or failed yet.`,
      runId: latest.id,
    };
  }

  if (exactRunCount === 0) {
    return {
      state: "never-run",
      label: "Never run",
      reason: "This saved definition has no executions yet.",
      runId: null,
    };
  }

  return {
    state: "unknown",
    label: "Status unknown",
    reason: "There is not enough loaded activity to determine current health.",
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
