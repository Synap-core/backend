/**
 * `@synap-core/types/workers` — the ONE vocabulary of stage workers (work
 * model L4).
 *
 * A worker is a playbook ACTIVATOR declared on a lifecycle (catalog) and
 * ENABLED for a scope (the whole space, or one project / track). It is
 * configuration, not a noun: the enablement is a governed rule, the work it
 * does is a session.
 *
 * Two shapes live here, both read by the pod AND the surfaces:
 *
 *   - {@link WorkerActivator} — WHEN a worker fires, how big each run is, and
 *     whether it runs or proposes. Mirrored by `PlaybookActivator`
 *     (`@synap/playbooks`, dependency-free) and validated by the pod's
 *     `playbook-process` zod schema.
 *   - the TARGET edge — `session --targets--> entity` with
 *     `links.metadata.role === WORKER_TARGET_ROLE` and a per-thing `result`.
 *     A target with no `result` is still being worked; every other state is a
 *     mark ({@link WORKER_TARGET_RESULTS}), never an absence.
 *
 * Leaf module: imports nothing, so the browser, relay, CLI and every backend
 * package can read it.
 */

// ── Activator ───────────────────────────────────────────────────────────────

/**
 * WHEN a worker fires.
 *
 *   created        — a thing of the subject kind is created (a role: attached).
 *   enters_status  — the subject enters `status`.
 *   schedule       — on `cron` (UTC), over the things currently in `status`
 *                    (or every thing of the subject, without one).
 *   count          — when at least `min` things sit in `status`; always
 *                    `per_moment` (the count IS the moment).
 *   manual         — never by itself: a button that runs the worker over its
 *                    enablement's filter. Compiles no rule.
 */
export const WORKER_ACTIVATOR_TRIGGERS = [
  "created",
  "enters_status",
  "schedule",
  "count",
  "manual",
] as const;
export type WorkerActivatorTrigger = (typeof WORKER_ACTIVATOR_TRIGGERS)[number];

/**
 * How much one run covers.
 *
 *   per_thing   — one session per thing (the subject is that thing).
 *   per_moment  — one session for the whole set; each thing is a TARGET of it
 *                 (`session --targets--> entity`), never its subject.
 */
export const WORKER_SIZES = ["per_thing", "per_moment"] as const;
export type WorkerSize = (typeof WORKER_SIZES)[number];

/** `run` starts the session; `propose` files it for a person to approve. */
export const WORKER_MODES = ["run", "propose"] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];

export const DEFAULT_WORKER_SIZE: WorkerSize = "per_thing";
export const DEFAULT_WORKER_MODE: WorkerMode = "propose";

/**
 * Pending approvals a worker may have waiting on a person before it stops
 * starting new runs (`approvals_backlog`). The softer, earlier limit above the
 * per-agent pending-proposal cap, so a batch never hits that refusal halfway.
 */
export const DEFAULT_WORKER_MAX_PENDING_APPROVALS = 20;
export const WORKER_MAX_PENDING_APPROVALS_CEILING = 200;

/**
 * The most things ONE per_moment run takes on. The rest wait for the next
 * moment (they are not in flight, so the next run picks them up).
 */
export const WORKER_BATCH_LIMIT = 50;

/** A `count` worker's floor: a threshold of one is just `enters_status`. */
export const WORKER_COUNT_MIN_FLOOR = 2;

export interface WorkerActivator {
  on: WorkerActivatorTrigger;
  /** The lifecycle option: required for `enters_status` and `count`,
   *  optional for `schedule` (narrows the set). */
  status?: string;
  /** Cron expression (UTC). Required for `schedule`. */
  cron?: string;
  /** Threshold for `count` (≥ {@link WORKER_COUNT_MIN_FLOOR}). */
  min?: number;
  /** Default {@link DEFAULT_WORKER_SIZE}; `count` forces `per_moment`. */
  size?: WorkerSize;
  /** Default {@link DEFAULT_WORKER_MODE}. */
  mode?: WorkerMode;
  /** Default {@link DEFAULT_WORKER_MAX_PENDING_APPROVALS}. */
  maxPendingApprovals?: number;
}

/** The size a declared activator runs at (`count` is always `per_moment`). */
export function effectiveWorkerSize(
  a: Pick<WorkerActivator, "on" | "size">
): WorkerSize {
  if (a.on === "count") return "per_moment";
  return a.size ?? DEFAULT_WORKER_SIZE;
}

// ── Enablement scope ────────────────────────────────────────────────────────

/**
 * Where an enabled worker runs. `space` = every thing of the subject in the
 * playbook's space (what installing a playbook with activators turns on);
 * `project` = only the things filed in that project (a track enables for its
 * project and files its sessions in the track).
 */
export const WORKER_SCOPES = ["space", "project"] as const;
export type WorkerScopeKind = (typeof WORKER_SCOPES)[number];

// ── Targets ─────────────────────────────────────────────────────────────────

/**
 * `links.metadata.role` of a worker's target edge. A `role: "input"` edge
 * (`attachSessionInput`) is a different population and never gets a result.
 */
export const WORKER_TARGET_ROLE = "worker_target" as const;

/**
 * What the worker did with ONE target.
 *
 *   done     — the thing reached the worker's goal.
 *   failed   — the worker tried and could not.
 *   skipped  — not worked (a person moved it first, the session closed, a
 *              ceiling held it back — see {@link WORKER_TARGET_REASONS}).
 *   created  — the worker created this thing.
 *
 * Words: `resolveStatusLabel` (`@synap-core/types/vocabulary`).
 */
export const WORKER_TARGET_RESULTS = [
  "done",
  "failed",
  "skipped",
  "created",
] as const;
export type WorkerTargetResult = (typeof WORKER_TARGET_RESULTS)[number];

/** Why a target got the result it did. Tokens; words via `humanizeToken`. */
export const WORKER_TARGET_REASONS = {
  /** A person (or another session) moved the thing while this one worked. */
  movedByPerson: "moved_by_person",
  /** The session closed before the worker reached it. */
  sessionClosed: "session_closed",
  /** The thing had already left the worker's status when the run started. */
  staleTransition: "stale_transition",
  /** The system's daily ceiling on irreversible sends held it back. */
  volumeCeiling: "volume_ceiling",
} as const;
export type WorkerTargetReason =
  (typeof WORKER_TARGET_REASONS)[keyof typeof WORKER_TARGET_REASONS];

/** The `links.metadata` of a worker target edge. */
export interface WorkerTargetMetadata {
  role: typeof WORKER_TARGET_ROLE;
  /** Absent = still being worked. First verdict wins. */
  result?: WorkerTargetResult;
  reason?: WorkerTargetReason | (string & {});
  /** ISO time the result was stamped. */
  at?: string;
  /** The transition event that settled (or started) it, when one did. */
  transitionEventId?: string;
}

export function isWorkerTargetResult(v: unknown): v is WorkerTargetResult {
  return (
    typeof v === "string" &&
    (WORKER_TARGET_RESULTS as readonly string[]).includes(v)
  );
}

/**
 * Read a `links.metadata` value as a worker target, or `null` when the edge is
 * not one (an input edge, a project edge, garbage). An unknown `result` reads
 * as absent rather than leaking a raw token as a state.
 */
export function readWorkerTargetMetadata(
  metadata: unknown
): WorkerTargetMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  if (m.role !== WORKER_TARGET_ROLE) return null;
  const out: WorkerTargetMetadata = { role: WORKER_TARGET_ROLE };
  if (isWorkerTargetResult(m.result)) out.result = m.result;
  if (typeof m.reason === "string" && m.reason) out.reason = m.reason;
  if (typeof m.at === "string" && m.at) out.at = m.at;
  if (typeof m.transitionEventId === "string" && m.transitionEventId) {
    out.transitionEventId = m.transitionEventId;
  }
  return out;
}

// ── Run skip reasons ────────────────────────────────────────────────────────

/**
 * Why a worker fired and started nothing. Appended to
 * `AUTOMATION_SKIP_REASONS` (`automations/rule-run-policy.ts`), so a run row
 * reads them through the same words.
 */
export const WORKER_SKIP_REASONS = {
  /** A `count` worker found fewer than `min` things in the status. */
  belowThreshold: "below_threshold",
  /** The worker already has `maxPendingApprovals` waiting on a person. */
  approvalsBacklog: "approvals_backlog",
  /** The thing left the status before the worker started (fast moves). */
  staleTransition: "stale_transition",
  /** The daily irreversible-send ceiling for this worker is used up. */
  volumeCeiling: "volume_ceiling",
} as const;
export type WorkerSkipReason =
  (typeof WORKER_SKIP_REASONS)[keyof typeof WORKER_SKIP_REASONS];
