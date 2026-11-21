/**
 * The `focus_sessions.status` vocabulary — ONE declaration, platform-wide.
 *
 * Lives in `@synap-core/types` (a leaf module with no runtime import but the
 * category-set leaf, safe in browser, Electron, Node and CLI) because the
 * backend is no longer the only consumer: the browser renders a session's
 * lifecycle and would otherwise mint a fourth hand-written copy of these
 * strings — the hand-mirrored-vocabulary defect this platform keeps paying for.
 *
 * `packages/api/src/services/focus-sessions/session-statuses.ts` re-exports
 * these, so every existing backend importer is unchanged.
 *
 * A lockstep tripwire (`__tripwires__/declared-enum-covers-column.test.ts`)
 * asserts `SESSION_STATUSES` covers the `focus_sessions.status` column enum, so
 * a new stored state can never exist that this list does not know about.
 *
 * Every SET of statuses below (open, terminal, suspended, live) is DERIVED
 * from {@link SESSION_STATUS_DECLARATION}'s categories, never written out a
 * second time: a reader that needs another set calls {@link sessionStatusesIn}
 * (`__tripwires__/status-lists-derived.tripwire.test.ts` fails a new hand
 * list).
 */
import type { LifecycleCategory } from "../lifecycle/option.js";
import {
  categoryOf,
  statusesInCategories,
  type StatusOfCategory,
} from "../lifecycle/category-sets.js";

/**
 * Every `focus_sessions.status` value (mirrors the schema's column enum). Used
 * to validate a model-supplied `status` filter — see synap_list_sessions — and
 * to derive the zod enums on the tRPC and Hub REST doors.
 */
export const SESSION_STATUSES = [
  "active",
  "paused",
  "forming",
  "scheduled",
  "closed",
  "failed",
  "cancelled",
  // Added by the focus-session reaper (a long-idle `running` session is marked
  // stale rather than deleted). Must be listable, or list_sessions({status:
  // "stale"}) rejects a status the schema legitimately produces.
  "stale",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * THE session lifecycle, declared ONCE like a goal's
 * (`TRACK_STATUS_DECLARATION`): each stored status's fixed CATEGORY. Keyed by
 * every status, so a status added to {@link SESSION_STATUSES} and not
 * classified here stops the build. Read by the session transition
 * (`setSessionStatus`, @synap/database), by any status rollup, and by every
 * status SET in this module. A derived set takes the order of these keys,
 * which keep the order each set had as a hand list (the terminal set's
 * `closed, cancelled, failed` is a published MCP / Hub enum order).
 *
 *   open    forming (planned: a plan step, {@link PLANNED_SESSION_STATUS}),
 *           scheduled (an appointment) — not started;
 *   active  active;
 *   paused  paused (a person or a check gate), stale (the reaper found it
 *           quiet). `stale` KEEPS its stored value (founder decision
 *           2026-09-13: Relay's Work home admits it for 7 days, and the
 *           reaper matches `active`/`paused` only, so a stale row stored as
 *           `paused` would be re-reaped every hour); it READS as paused
 *           everywhere (founder, 2026-11-20);
 *   done    closed;
 *   lost    failed, cancelled.
 */
export const SESSION_STATUS_DECLARATION = {
  active: { category: "active" },
  paused: { category: "paused" },
  forming: { category: "open" },
  scheduled: { category: "open" },
  closed: { category: "done" },
  cancelled: { category: "lost" },
  failed: { category: "lost" },
  stale: { category: "paused" },
} as const satisfies Record<SessionStatus, { category: LifecycleCategory }>;

/**
 * PLANNED — `forming` (founder decision P1, 21 Nov 2026): a step of a plan
 * that has not started. It starts when its blockers deliver and its planned
 * date comes (the wake, api `planned-wake.ts`), or when someone starts it.
 * Until then it owes nothing (`classifyOwedAsk`, the owed-slot predicate),
 * is not where a write is filed (`IN_FLIGHT_SESSION_STATUSES`) and never
 * reads as running. Its readiness is {@link deriveStepReadiness}
 * (`units/session.ts`). `scheduled` is the OTHER not-started status: an
 * appointment a playbook opens on a clock.
 */
export const PLANNED_SESSION_STATUS =
  "forming" as const satisfies SessionStatus;

export function isPlannedSessionStatus(
  v: string | null | undefined
): v is typeof PLANNED_SESSION_STATUS {
  return v === PLANNED_SESSION_STATUS;
}

/** A status that has not ended: categories `open`, `active`, `paused`. */
type NotEndedSessionStatus = StatusOfCategory<
  typeof SESSION_STATUS_DECLARATION,
  "open" | "active" | "paused"
>;

/** The session statuses whose category is one of `categories`. */
export function sessionStatusesIn<C extends LifecycleCategory>(
  categories: readonly C[]
): StatusOfCategory<typeof SESSION_STATUS_DECLARATION, C>[] {
  return statusesInCategories(SESSION_STATUS_DECLARATION, categories);
}

/** The category of a session status; `null` for a value no status declares. */
export function sessionStatusCategory(
  status: string | null | undefined
): LifecycleCategory | null {
  return categoryOf(SESSION_STATUS_DECLARATION, status);
}

/**
 * Terminal statuses — the lifecycle exits (categories `done` and `lost`).
 * Every one of them MUST go through `completeFocusSession` (pack + run close +
 * ephemeral expiry + close event); a door that stamps one of these directly is
 * the dual-path defect.
 */
export type TerminalSessionStatus = StatusOfCategory<
  typeof SESSION_STATUS_DECLARATION,
  "done" | "lost"
>;
/** A non-empty tuple type: `z.enum` takes it at the terminal-status doors. */
export const TERMINAL_SESSION_STATUSES = sessionStatusesIn([
  "done",
  "lost",
]) as readonly TerminalSessionStatus[] as readonly [
  TerminalSessionStatus,
  ...TerminalSessionStatus[],
];

/**
 * Non-terminal statuses — a session still "in flight" for its owner: the
 * `open`, `active` and `paused` categories EXCEPT `stale`. The exception is
 * deliberate (founder decision 2026-09-13, above): a reaped session leaves the
 * open lists and comes back only through the windows that admit it by
 * recency (`WINDOWED_SESSION_STATUSES`, api `session-status-filter.ts`). It
 * still READS as paused ({@link sessionStatusCategory}).
 */
export type OpenSessionStatus = Exclude<NotEndedSessionStatus, "stale">;
export const OPEN_SESSION_STATUSES: readonly OpenSessionStatus[] =
  sessionStatusesIn(["open", "active", "paused"]).filter(
    (s): s is OpenSessionStatus => s !== "stale"
  );

/**
 * Open and STARTED: active, paused — the `open` category (a planned step,
 * `forming`, and an appointment, `scheduled`) is left out: neither has
 * started. The sessions still being worked: where a write is filed, a client
 * bound, a subject's status move followed, a grade owed. A planned step
 * joins when it wakes (P1, 21 Nov 2026; `forming` was in this set while
 * nothing wrote it).
 */
export type InFlightSessionStatus = Exclude<
  OpenSessionStatus,
  "scheduled" | "forming"
>;
export const IN_FLIGHT_SESSION_STATUSES: readonly InFlightSessionStatus[] =
  sessionStatusesIn(["active", "paused"]).filter(
    (s): s is InFlightSessionStatus => s !== "stale" || true
  );

/**
 * Started and not ended — the `active` and `paused` categories: active,
 * paused, stale. What an owed slot can still park a run on, what a needs-you
 * read counts as a session still at work.
 */
export type UnderwaySessionStatus = StatusOfCategory<
  typeof SESSION_STATUS_DECLARATION,
  "active" | "paused"
>;
export const UNDERWAY_SESSION_STATUSES: readonly UnderwaySessionStatus[] =
  sessionStatusesIn(["active", "paused"]);

/**
 * How a session ENDED — its `closedAs`. "Delivered" means the work was done,
 * not that the session closed (founder, 2026-11-20):
 *
 *   done      closed (category `done`) with nothing required left open;
 *   not_done  closed ANYWAY with required work open — an agent's
 *             close-anyway, recorded by the close door on
 *             `verification_report.closedNotDone` (`close-not-done.ts`) — or
 *             ended `lost` (failed, cancelled);
 *   null      not ended.
 *
 * THE one derivation: the close event's `closedAs` (what a `run_ended` link
 * reads) and the dependency rule's "delivered" (`classifyDependencyBlocker`)
 * both read it. A closed row with no record — every close by a person, an
 * approval or an automatic close, and every close before the record existed
 * (F11) — is `done`: no required work was recorded open, so no historical
 * chain re-blocks.
 */
export const SESSION_CLOSE_OUTCOMES = ["done", "not_done"] as const;
export type SessionClosedAs = (typeof SESSION_CLOSE_OUTCOMES)[number];

export function sessionClosedAs(
  status: string | null | undefined,
  closedNotDone: boolean
): SessionClosedAs | null {
  const category = sessionStatusCategory(status);
  if (category === "done") return closedNotDone ? "not_done" : "done";
  return category === "lost" ? "not_done" : null;
}

export function isTerminalSessionStatus(
  v: string | null | undefined
): v is TerminalSessionStatus {
  return (
    v != null && (TERMINAL_SESSION_STATUSES as readonly string[]).includes(v)
  );
}

/**
 * A CLOSED RUN STAYS CLOSED (work model R8). A session that ended — closed,
 * cancelled or failed — never moves back to an open status through an update
 * door: more work is a NEW run (rerun, or start a session). Every door that
 * writes `status` asks this one function: tRPC `focusSessions.update`, the
 * MCP/Hub service `updateFocusSession`, Hub REST `PATCH /focus-sessions/:id`
 * and the `focus_session/update` approval replay. `null` = allowed.
 *
 * THE ONE EXCEPTION (founder, 2026-11-04, decision 3da00cda, finding
 * 8748feab): a PERSON may reopen a run that ended `cancelled`, back to
 * `active` — a cancel made by mistake is undone, not routed around. An agent
 * never may, and is refused with that reason (never proposed). `closed` and
 * `failed` keep their history for everyone. `actor` is who asks: a door that
 * cannot tell (the approval replay, which runs what an agent filed) passes
 * nothing and is refused like an agent. The reopen itself runs through ONE
 * door, `reopenCancelledSession` (api `services/focus-sessions`), never a bare
 * status write: see {@link isCancelledRunReopen}.
 *
 * Narrow on purpose: a terminal → terminal relabel (closed → cancelled) is not
 * a reopening and is not refused here.
 */
export function closedRunRefusal(
  from: string | null | undefined,
  to: string | null | undefined,
  actor?: "person" | "agent" | null
): string | null {
  if (to == null || from === to) return null;
  if (!isTerminalSessionStatus(from) || isTerminalSessionStatus(to)) {
    return null;
  }
  if (from === "cancelled") {
    if (actor === "person") {
      return to === "active"
        ? null
        : "A cancelled run reopens as active only: set its status to active.";
    }
    return "This run is cancelled — a closed run stays closed for an agent: only a person can reopen a cancelled run, from the session in Synap. Start a new run to keep working.";
  }
  return `This run is ${from} — a closed run stays closed. Start a new run to keep working.`;
}

/**
 * Is this move the person's reopen of a cancelled run (the one exception
 * {@link closedRunRefusal} lets through)? A door that sees `true` hands the
 * move to `reopenCancelledSession` instead of writing the status itself.
 */
export function isCancelledRunReopen(
  from: string | null | undefined,
  to: string | null | undefined
): boolean {
  return from === "cancelled" && to === "active";
}

/**
 * Suspended statuses — the `paused` category: resumable, and not moving:
 * `paused` by a person, or `stale` (the reaper found the session quiet). NOT
 * terminal: either can pick
 * up again. THE ONE READING of `stale` for a person-facing state filter —
 * Work › Sessions files it with Paused through this set, never beside Done.
 * (Activity's outcome for a session row is a different axis — how an act
 * ended — and draws `stopped` with the same pause mark.)
 */
export type SuspendedSessionStatus = StatusOfCategory<
  typeof SESSION_STATUS_DECLARATION,
  "paused"
>;
export const SUSPENDED_SESSION_STATUSES: readonly SuspendedSessionStatus[] =
  sessionStatusesIn(["paused"]);

export function isSuspendedSessionStatus(
  v: string | null | undefined
): v is SuspendedSessionStatus {
  return (
    v != null && (SUSPENDED_SESSION_STATUSES as readonly string[]).includes(v)
  );
}

/**
 * The states a CLIENT may write. Every stored state EXCEPT `stale`, which only
 * the focus-session reaper stamps — a caller declaring its own session stale is
 * a category error.
 *
 * DERIVED from `SESSION_STATUSES` so a new stored state is writable by default
 * and the one exclusion stays a single, visible decision, instead of the two
 * hand-mirrored seven-string literals the tRPC `focusSessions.update` input and
 * the Hub REST `PATCH` body each used to carry.
 *
 * Typed as a non-empty tuple because `z.enum` requires one; that cast lives
 * here, once, rather than at each door.
 */
export const UPDATABLE_SESSION_STATUSES = SESSION_STATUSES.filter(
  (s): s is Exclude<SessionStatus, "stale"> => s !== "stale"
) as [Exclude<SessionStatus, "stale">, ...Exclude<SessionStatus, "stale">[]];

/**
 * A RUN that is LIVE on its subject: every stored status except the terminal
 * ones and `scheduled` (an appointment has run nothing) — active, paused,
 * forming, stale. An agent's draft waiting for the person's acceptance is
 * `active`, so it is live too (founder, 2026-11-16, "one live run per
 * object" decision 3).
 *
 * THE set "one live run per object" counts: the run door answers
 * `already_running` while a run of the playbook is live on the object
 * (`playbooks.run`), and the partial unique index
 * `uniq_focus_sessions_one_live_run` (migration 0427) lists the same
 * statuses, pinned by `migrations-0427.pglite.test.ts`. A client showing
 * "Running, open it" reads this list, never its own.
 *
 * DERIVED from the declaration: the `open`, `active` and `paused` categories
 * except `scheduled`, so a new stored status is live unless it is terminal or
 * `scheduled`. A PLANNED step (`forming`) stays in on purpose (P1, 21 Nov
 * 2026): a planned run of a playbook on a thing IS that thing's run, and a
 * second one beside it would be the twin this set exists to refuse.
 */
export type LiveRunSessionStatus = Exclude<NotEndedSessionStatus, "scheduled">;
export const LIVE_RUN_SESSION_STATUSES: readonly LiveRunSessionStatus[] =
  sessionStatusesIn(["open", "active", "paused"]).filter(
    (s): s is LiveRunSessionStatus => s !== "scheduled"
  );
