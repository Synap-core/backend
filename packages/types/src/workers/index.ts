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
 * Leaf module: its one import is the session status leaf (itself
 * dependency-free), so the browser, relay, CLI and every backend package can
 * read it.
 */

import { SESSION_CLOSE_OUTCOMES } from "../focus-sessions/statuses.js";

// ── Activator ───────────────────────────────────────────────────────────────

/**
 * WHEN a worker fires.
 *
 *   created        — a thing of the subject kind is created (a role: attached).
 *   enters_status  — the subject enters `status`.
 *   schedule       — on `cron` in `timezone`, over the things currently in
 *                    `status` (or every thing of the subject, without one):
 *                    one session for the set (`per_moment`, the default) or
 *                    one per thing (`per_thing`). A playbook with no subject
 *                    runs once per tick.
 *   count          — when at least `min` things sit in `status`; always
 *                    `per_moment` (the count IS the moment).
 *   manual         — never by itself: a button that runs the worker over its
 *                    enablement's filter. Compiles no rule.
 *   run_ended      — a LINK: a run of another playbook (`playbook`) ended,
 *                    done or not (`outcome`, absent = either). The new run
 *                    works on the ended run's subject. Space-wide only.
 */
export const WORKER_ACTIVATOR_TRIGGERS = [
  "created",
  "enters_status",
  "schedule",
  "count",
  "manual",
  "run_ended",
] as const;
export type WorkerActivatorTrigger = (typeof WORKER_ACTIVATOR_TRIGGERS)[number];

/**
 * How a run ended, for a `run_ended` link: its session's `closedAs`
 * (`sessionClosedAs`, focus-sessions/statuses.ts) — `done` = closed with
 * nothing required left open (no `closedNotDone` record); `not_done` = closed
 * anyway with required work open, or cancelled or failed.
 */
export const WORKER_RUN_OUTCOMES = SESSION_CLOSE_OUTCOMES;
export type WorkerRunOutcome = (typeof WORKER_RUN_OUTCOMES)[number];

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

/**
 * What an activator may declare: a worker mode, or `appointment` (schedule
 * only) — each tick opens a `scheduled` session that waits for the person.
 */
export const WORKER_ACTIVATOR_MODES = [...WORKER_MODES, "appointment"] as const;
export type WorkerActivatorMode = (typeof WORKER_ACTIVATOR_MODES)[number];

/** A declared status: one value, or (schedule only) a list. */
export type WorkerStatusSpec = string | string[];

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
  /** `run_ended` only (required): the linked playbook, by name or id. */
  playbook?: string;
  /** `run_ended` only: which end starts it; absent = any. */
  outcome?: WorkerRunOutcome;
  /** The lifecycle option: required for `enters_status` and `count`,
   *  optional for `schedule` (narrows the set; a list there). */
  status?: WorkerStatusSpec;
  /** Cron expression. Required for `schedule`. */
  cron?: string;
  /** `schedule` only: the IANA zone `cron` is read in; absent = the owner's. */
  timezone?: string;
  /** `schedule` only: installed paused — the person turns it on. */
  startsPaused?: true;
  /** `schedule` in `run` mode only: the agent each run is handed to. */
  handToAgentId?: string;
  /** Threshold for `count` (≥ {@link WORKER_COUNT_MIN_FLOOR}). */
  min?: number;
  /** Default {@link DEFAULT_WORKER_SIZE}; `count` is `per_moment`, `schedule` defaults to it. */
  size?: WorkerSize;
  /** Default {@link DEFAULT_WORKER_MODE}. */
  mode?: WorkerActivatorMode;
  /** Default {@link DEFAULT_WORKER_MAX_PENDING_APPROVALS}. */
  maxPendingApprovals?: number;
  /**
   * A per-thing worker (`created` / `enters_status`) leaves out a thing that
   * carries this property: e.g. Content OS's Repurpose skips a post sent for
   * another one (`post-copy-of`), so a post that went out on three accounts
   * files one proposal, not three. See {@link skippedByUnless}.
   */
  unless?: WorkerUnless;
  /**
   * A per-thing worker (`created` / `enters_status`) keeps only a thing whose
   * property holds one of these values: e.g. Content OS proposes Produce a
   * video only for a post whose `post-format` is a video format, and the text
   * and image processes theirs. See {@link skippedByOnly}.
   */
  only?: WorkerOnly;
}

/**
 * "Unless the thing carries `property`": present = a value that is not null,
 * not an empty string and not an empty list. One shape on purpose: the
 * activator's other rules are read off its trigger, and this one is read off
 * the thing itself when the worker fires (the trigger's payload does not carry
 * the thing's properties).
 */
export interface WorkerUnless {
  property: string;
  present: true;
}

/** Does `unless` leave this thing out? Pure; `properties` is the thing's own. */
export function skippedByUnless(
  unless: WorkerUnless | undefined,
  properties: Record<string, unknown> | null | undefined
): boolean {
  if (!unless) return false;
  const v = properties?.[unless.property];
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * "Only a thing whose `property` is one of `in`": read off the thing when the
 * worker fires, like {@link WorkerUnless}. Values compare trimmed and without
 * case ("Short Video" = "short video"); a list property is kept when any of its
 * items is listed. A thing with no value for it is left out.
 */
export interface WorkerOnly {
  property: string;
  in: string[];
}

/** Does `only` leave this thing out? Pure; `properties` is the thing's own. */
export function skippedByOnly(
  only: WorkerOnly | undefined,
  properties: Record<string, unknown> | null | undefined
): boolean {
  if (!only) return false;
  const wanted = new Set(only.in.map((v) => v.trim().toLowerCase()));
  const v = properties?.[only.property];
  const values = Array.isArray(v) ? v : [v];
  return !values.some(
    (x) => typeof x === "string" && wanted.has(x.trim().toLowerCase())
  );
}

/**
 * The size a declared activator runs at. `count` is always `per_moment` (the
 * threshold has no single thing); a `schedule` is `per_moment` unless it
 * declares `per_thing` (one run per thing in its set at each tick).
 */
export function effectiveWorkerSize(
  a: Pick<WorkerActivator, "on" | "size">
): WorkerSize {
  if (a.on === "count") return "per_moment";
  if (a.on === "schedule") return a.size ?? "per_moment";
  return a.size ?? DEFAULT_WORKER_SIZE;
}

/** A declared `status` as a list: [] when absent. */
export function workerStatuses(
  status: string | readonly string[] | null | undefined
): string[] {
  if (status === null || status === undefined) return [];
  return typeof status === "string" ? [status] : [...status];
}

/**
 * The stable identity of an activator within one playbook: what
 * `workers.enable` / `synap_enable_worker` take as `activatorKey`. size, mode
 * and maxPendingApprovals stay OUT of the key: changing them moves the decl
 * hash, and the convergence UPDATES the same rule in place. The pod's
 * `activatorKey` (`schemas/playbook-process.ts`) is this function.
 */
/** Is this activator key a `schedule`'s (`workerActivatorKey`)? */
export function isScheduleActivatorKey(
  key: string | null | undefined
): boolean {
  return typeof key === "string" && key.startsWith("schedule:");
}

/** Is this activator key a `run_ended` link's (`workerActivatorKey`)? */
export function isLinkActivatorKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith("run_ended:");
}

/**
 * How many link-started runs back a link looks for the playbook it would
 * start (the run-time loop guard, `@synap/jobs` `utils/link-lineage.ts`). A
 * chain this long is refused too: no real chain of playbooks is.
 */
export const LINK_CHAIN_MAX = 32;

export function workerActivatorKey(a: {
  on: string;
  status?: string | readonly string[] | null;
  cron?: string | null;
  playbook?: string | null;
  outcome?: string | null;
}): string {
  if (a.on === "enters_status")
    return `enters_status:${workerStatuses(a.status).join(",")}`;
  if (a.on === "count") return `count:${workerStatuses(a.status).join(",")}`;
  if (a.on === "schedule")
    return `schedule:${(a.cron ?? "").trim().split(/\s+/).join(" ")}`;
  if (a.on === "run_ended")
    return `run_ended:${(a.playbook ?? "").trim()}${a.outcome ? `:${a.outcome}` : ""}`;
  return a.on;
}

// ── Enablement scope ────────────────────────────────────────────────────────

/**
 * Where an enabled worker runs. `space` = every thing of the subject in the
 * playbook's space (what installing a playbook with activators turns on);
 * `project` = only the things filed in that project (a track enables for its
 * project and files its sessions in the track); `session` = a SESSION started
 * it: it works over the things of the session's project (the space when the
 * session is unfiled), files its runs where the session is filed, and every
 * run is a CHILD of the session (`spawned_from`). It stops once the session
 * is no longer open (its runs are skipped `session_closed`; nothing moves).
 */
export const WORKER_SCOPES = ["space", "project", "session"] as const;
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
  /** The thing carries the activator's `unless` property (see {@link skippedByUnless}). */
  unlessProperty: "unless_property",
  /** The thing's property holds none of the activator's `only` values (see {@link skippedByOnly}). */
  onlyValues: "only_values",
  /**
   * A `run_ended` link would start a playbook already in the chain of
   * link-started runs that led here (a loop), or the chain is longer than
   * {@link LINK_CHAIN_MAX}.
   */
  linkLoop: "link_loop",
} as const;
export type WorkerSkipReason =
  (typeof WORKER_SKIP_REASONS)[keyof typeof WORKER_SKIP_REASONS];

/**
 * A playbook's schedule as every surface reads it: its clock, the zone it
 * runs in (`null` = its owner's), and whether it fires now. Projected by the
 * playbook reads (`playbooks.list`, `get`); a client never joins activators
 * with rule status itself.
 */
export interface PlaybookScheduleView {
  cron: string;
  timezone: string | null;
  on: boolean;
}

/**
 * THE schedule of one playbook: its enabled schedule worker (a running one
 * first), else a retired `playbooks.schedule` no activator could say (it
 * still fires through its own automation while `enabled`), else none.
 */
export function playbookScheduleOf(input: {
  workers: ReadonlyArray<{
    activator: Pick<WorkerActivator, "on" | "cron" | "timezone"> | null;
    state: "running" | "paused" | "stopped";
  }>;
  retired?: unknown;
}): PlaybookScheduleView | null {
  const clocks = input.workers.filter(
    (w) => w.activator?.on === "schedule" && w.activator.cron
  );
  const worker = clocks.find((w) => w.state === "running") ?? clocks[0];
  if (worker) {
    return {
      cron: worker.activator!.cron!,
      timezone: worker.activator!.timezone ?? null,
      on: worker.state === "running",
    };
  }
  const retired = input.retired as
    { cron?: unknown; enabled?: unknown } | null | undefined;
  if (typeof retired?.cron !== "string" || !retired.cron) return null;
  return {
    cron: retired.cron,
    // The retired column's cron was always read in UTC.
    timezone: "UTC",
    on: retired.enabled !== false,
  };
}
