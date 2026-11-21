/**
 * A FOCUS SESSION (or a project's sessions) → `UnitStateInput`.
 *
 * `resolveUnitState` decides a state; this module only says what the pod's
 * session facts MEAN in that function's vocabulary. It lives here, beside the
 * derivation, so Relay and the browser import ONE translation. It used to live
 * only in Relay (`work-units.ts`, `project-aggregate-state.ts`), which left the
 * browser with three local derivations of its own and no way to agree with the
 * phone.
 *
 * ── Judgement calls, stated once ───────────────────────────────────────────
 *
 * **`scheduled` / `paused` need a `schedule`, and a session has no cron.** The
 * derivation reaches those two states only through `{ cron, enabled }`, a shape
 * written for recurring playbooks. A session carries an appointment and a
 * lifecycle status, never a cron. So a `scheduled`/`paused` session is handed
 * `{ cron: <stored cron, or ''>, enabled: status !== 'paused' }`. `enabled` is a
 * fact; the empty cron is a placeholder, never a fabricated cadence
 * (`describeCadence('')` returns `''`, which is falsy).
 *
 * **`stale` reads as paused, never working and never unmeasured.** The reaper
 * stamps `stale` on a session quiet for the ladder's `stale` rung
 * (`WORK_CLOCK.stale`, `@synap-core/types/work-clock`). That is a measured
 * fact, not an unknown: the session lifecycle files it under the `paused`
 * category (`SESSION_STATUS_DECLARATION`), so it is handed `idle` (the quiet
 * `paused` state) like every suspended session (`isSuspendedSessionStatus`).
 * It once mapped to `unreadable` (`unmeasured`), which made the phone draw a
 * reaped session as "could not read" while the pod filed it as paused.
 *
 * **"Working" needs a LIVE fact (founder decision D1, 2026-10-04).** An open
 * lifecycle (`active`) is not "an agent is working". When the
 * caller passes the pod's liveness facts (`live`), the session reads
 * `working` only while `isSessionWorkingNow` holds — a turn in flight or
 * activity inside `SESSION_WORKING_WINDOW_MS` — and otherwise `idle`, which
 * the derivation renders as the existing quiet state `paused` (muted tone,
 * pause glyph; no new tone). The Now line reads the same predicate, so the
 * header mark and the line agree. A caller WITHOUT liveness (`live`
 * undefined — an older pod) keeps the lifecycle reading.
 *
 * **`pendingDecisions` is three-valued.** `undefined` = the caller did not read
 * proposals (no claim either way), `null` = the read FAILED (→ `unmeasured`
 * unless something live outranks it), a number = the count.
 */

import {
  isPlannedSessionStatus,
  isSuspendedSessionStatus,
  isTerminalSessionStatus,
  sessionStatusCategory,
  type SessionClosedAs,
} from "../focus-sessions/statuses.js";
import { classifyDependencyBlocker } from "../connections/dependency.js";
import {
  isSessionWorkingNow,
  type SessionLiveFacts,
} from "../run-activity/live.js";
import { needsYouAgentWorking } from "../needs-you/rule.js";
import {
  resolveUnitState,
  type UnitStateInput,
  type UnitStateView,
} from "./state.js";
import {
  needsYouItems,
  sessionNeedsYou,
  type NeedsYouFacts,
} from "./needs-you.js";

/**
 * The lifecycle status meaning a person or agent is in the session. `forming`
 * is NOT running: it is a planned step that has not started (P1); it reads
 * `not_started`, or `blocked` while it waits on another.
 */
const RUNNING_SESSION_STATUSES: ReadonlySet<string> = new Set(["active", "forming"]);
/** The two the pod expresses as a lifecycle state rather than as a cron. */
const CADENCE_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "scheduled",
  "paused",
]);

export interface SessionUnitFacts {
  /** The pod's own `focus_sessions.status`. */
  status: string;
  /**
   * Slots this session owes THE PERSON. REQUIRED, three-valued like `live`:
   * `null` means the owed read FAILED, which is not zero; `undefined` means
   * the caller did not read it (a list asked without its facts) — no claim
   * either way, so the lifecycle reading stands.
   */
  owedFromYou: number | null | undefined;
  /** Pending proposals filed under this session. See the header. */
  pendingDecisions?: number | null;
  /** Title of the session this one waits on, when it is blocked. */
  blockedBy?: string | null;
  /** 0–100 as stored on the row. */
  progress?: number | null;
  /** A cadence the pod stored, when it stored one. */
  cron?: string | null;
  /**
   * The pod's liveness facts (`live` on `focusSessions.activity` /
   * `focusSessions.list` rows). Three-valued, like the counts: an object ⇒
   * `working` requires `isSessionWorkingNow`; `null` ⇒ the liveness read
   * FAILED, so neither working nor idle can be claimed (→ `unmeasured` unless
   * something actionable outranks it); `undefined` ⇒ not read (older pod) —
   * the lifecycle reading stands.
   */
  live?: SessionLiveFacts | null;
  /** The clock for the working window. Defaults to `Date.now()`. */
  now?: number;
}

/** One session row → the shared derivation's input. */
export function sessionUnitInput(facts: SessionUnitFacts): UnitStateInput {
  const cadence = CADENCE_SESSION_STATUSES.has(facts.status)
    ? { cron: facts.cron ?? "", enabled: facts.status !== "paused" }
    : null;

  // A closed session that still owes you a slot or a decision is on YOU, not
  // done (orchestrator decision 2026-10-04, same rule as `sessionRowInput`):
  // the derivation checks `terminal` BEFORE `owedFromYou`, so a terminal flag
  // here would read done on a session Home lists as "needs you". `null` (a
  // failed read) is NOT "nothing owed": a closed session whose count could
  // not be read claims no Done either, and reads `unmeasured`.
  const owesYou =
    (facts.owedFromYou ?? 0) > 0 || (facts.pendingDecisions ?? 0) > 0;
  const countUnread =
    facts.owedFromYou === null || facts.pendingDecisions === null;
  const open = RUNNING_SESSION_STATUSES.has(facts.status);
  // D1: with liveness in hand, an open session is working only while the ONE
  // rule says so; without it (older pod), the lifecycle reading stands.
  const liveUnread = facts.live === null;
  const working =
    open &&
    !liveUnread &&
    (facts.live === undefined ||
      isSessionWorkingNow(facts.live, facts.now ?? Date.now()));
  return {
    failed: facts.status === "failed",
    // `failed` is terminal too, but the derivation checks `failed` first.
    terminal: isTerminalSessionStatus(facts.status) && !owesYou && !countUnread,
    owedFromYou: facts.owedFromYou,
    pendingDecisions: facts.pendingDecisions,
    blockedBy: facts.blockedBy ?? null,
    running: working,
    // E2: MEASURED at work — its owed asks and decisions then read
    // "working". The needs-you rule's own clock when the pod sends it
    // (`lastAgentWorkAt`: never the asking itself, never a human act), so
    // the card and the rule's Working fold cannot fork; the D1 liveness for
    // an older pod; never the lifecycle reading.
    agentAtWork: open && agentAtWork(facts.live, facts.now ?? Date.now()),
    idle:
      isSuspendedSessionStatus(facts.status) ||
      (open && !working && !liveUnread),
    schedule: cadence,
    unreadable: open && liveUnread,
    // A planned step has not started: no rail, no "working" (P1).
    progress:
      typeof facts.progress === "number"
        ? { done: Math.max(0, Math.min(100, facts.progress)), total: 100 }
        : null,
  };
}

function agentAtWork(
  live: SessionLiveFacts | null | undefined,
  now: number
): boolean {
  if (!live) return false;
  return live.lastAgentWorkAt === undefined
    ? isSessionWorkingNow(live, now)
    : needsYouAgentWorking(
        {
          turnInFlight: live.turnInFlight,
          lastAgentWorkAt: live.lastAgentWorkAt,
        },
        now
      );
}

// ─── A project, as an aggregate over its sessions ──────────────────────────

export interface ProjectAggregateSessionFact {
  /** The session's own `status`, exactly as the row carries it. */
  status: string;
  /**
   * THE needs-you facts — the row's `unitFacts` (`projects.path` rows,
   * `focusSessions.list` rows under `nextMove: true`). When present, whether
   * this session needs you is decided ONLY by `sessionNeedsYou`
   * (`needs-you.ts`), the one rule.
   */
  unitFacts?: NeedsYouFacts;
  /**
   * @deprecated LEGACY input — the pod's `nextMove.actor`. Read ONLY when
   * `unitFacts` is absent, so callers that have not yet moved to `unitFacts`
   * keep compiling and keep their answer.
   *
   * It is the SAME rule minus one clause, not a second rule: the pod answers
   * `actor: "user"` for exactly `owed_slot`, `pending_proposal` and
   * `ready_to_close` — the rule's three populations — so the two disagree only
   * on an agent DRAFT (which the actor cannot see) and on a failed read. Pass
   * `unitFacts` to get the draft exclusion.
   */
  nextMoveActor?: "user" | "ai" | "none";
  /**
   * An agent draft still in triage (`triage.pending`). A draft never needs
   * you — `unitFacts.draft` says so on a current pod; this carries the row's
   * own triage for a pod whose `unitFacts` predate `draft`, and for the
   * legacy actor (which cannot see a draft at all).
   */
  draft?: boolean;
  /**
   * The session's liveness facts (`live` on a list / path row) — see
   * `SessionUnitFacts.live`. Three-valued: an object ⇒ "working" requires
   * `isSessionWorkingNow` (D1); `null` ⇒ the read FAILED; absent ⇒ not read
   * (an older pod — the lifecycle reading stands).
   */
  live?: SessionLiveFacts | null;
  /** The clock for the working window. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Does this session need you? `unitFacts` through the one rule, else the
 * legacy actor. Exported for the other per-session readers of a list page,
 * so none of them re-states the draft exclusion.
 */
export function aggregateNeedsYou(
  session: ProjectAggregateSessionFact
): boolean {
  const facts = factsOf(session);
  if (facts) return sessionNeedsYou(facts);
  if (session.draft) return false;
  return session.nextMoveActor === "user";
}

/**
 * The row's `unitFacts` with its own triage folded in: a draft still needs
 * you for its agent's terminal wait (D-R1), and for nothing else.
 */
function factsOf(
  session: ProjectAggregateSessionFact
): NeedsYouFacts | undefined {
  if (!session.unitFacts) return undefined;
  return session.draft
    ? { ...session.unitFacts, draft: true }
    : session.unitFacts;
}

/**
 * The session's needs-you count could not be read: its `unitFacts` say a
 * part FAILED (`needsYouItems` → null). A draft counts only its terminal
 * wait, so it is unread only when its runner read failed. Legacy
 * `nextMoveActor` rows carry no count to fail.
 */
function needsYouUnread(session: ProjectAggregateSessionFact): boolean {
  const facts = factsOf(session);
  return facts !== undefined && needsYouItems(facts) === null;
}

export interface ProjectAggregateStateInput {
  sessions: readonly ProjectAggregateSessionFact[];
  /** True when the sessions read FAILED — not merely empty. */
  unreadable: boolean;
}

/**
 * Reduce a project's sessions into ONE `UnitStateInput`.
 *
 * One leading fact is set at a time, because the derivation checks `terminal`
 * BEFORE `owedFromYou`: setting both would read a project with a live
 * obligation as `done`.
 *   1. any session needs you (THE rule, `sessionNeedsYou`) → `owedFromYou`
 *   2. every session is terminal → `terminal`
 *   3. otherwise, something open: `running` when an agent is working on one
 *      of them by THE rule (D1, `isSessionWorkingNow`, over each session's
 *      `live`), else `idle` (the quiet `paused` reading) — `unmeasured` when
 *      a liveness read failed. A session WITHOUT `live` (older pod) counts as
 *      working, the pre-D1 lifecycle reading.
 */
export function projectAggregateInput(
  input: ProjectAggregateStateInput
): UnitStateInput {
  if (input.unreadable) return { unreadable: true };

  const total = input.sessions.length;
  if (total === 0) return { everStarted: false };

  // THE rule (`needs-you.ts`): owed + pending decisions + awaiting review,
  // drafts excluded, + an agent waiting on you at the terminal.
  const needsYou = input.sessions.filter(aggregateNeedsYou).length;
  const closed = input.sessions.filter((s) =>
    isTerminalSessionStatus(s.status)
  ).length;
  const progress = { done: closed, total };

  if (needsYou > 0) return { owedFromYou: needsYou, progress };
  // A closed session whose needs-you count FAILED may still owe you: no Done.
  const unread = input.sessions.some(needsYouUnread);
  if (closed === total && !unread) return { terminal: true, progress };
  // D1: an open session is "working" only by the ONE rule when its liveness
  // was read; a session without liveness (older pod) keeps the lifecycle
  // reading. Working anywhere ⇒ running; else a FAILED liveness read ⇒
  // unmeasured (never a calm "quiet"); else every open session is idle.
  const open = input.sessions.filter((s) => !isTerminalSessionStatus(s.status));
  const working = open.some(
    (s) =>
      s.live === undefined ||
      (s.live !== null && isSessionWorkingNow(s.live, s.now ?? Date.now()))
  );
  if (working) return { running: true, everStarted: true, progress };
  // A failed needs-you count is not "nothing owed": never a calm "quiet".
  if (unread || open.some((s) => s.live === null)) {
    return { unreadable: true, progress };
  }
  return { idle: true, everStarted: true, progress };
}

/** One session ROW — the aggregate fact plus what a single row can also know. */
export interface SessionRowFact extends ProjectAggregateSessionFact {
  /**
   * Title of an OPEN session this one waits on (a `blocked_by` link whose
   * target is still open). Waiting on X is not waiting on you: it reads
   * `blocked`, below "needs you" and above "working".
   */
  blockedBy?: string | null;
}

/**
 * The same reduction for ONE session row. The needs-you question is decided by
 * THE rule (`aggregateNeedsYou` → `sessionNeedsYou`, drafts never); EVERYTHING
 * else — failed / owed / terminal / blocked / paused / stale precedence — is
 * decided by `sessionUnitInput`, the ONE per-session lifecycle, so the same
 * session reads the same on the header, sidebar, Relay hero and every path row.
 * (Before, this function kept its own terminal shortcut: a `failed` row read
 * DONE here and FAILED on the header.)
 *
 * A closed session that still owes you a slot or a decision is on YOU, not
 * done (orchestrator decision 2026-10-04) — `sessionUnitInput` encodes that.
 */
export function sessionRowInput(session: SessionRowFact): UnitStateInput {
  const needsYou = aggregateNeedsYou(session);
  const input = sessionUnitInput({
    status: session.status,
    // A failed count stays FAILED (`null` → unmeasured), never a measured 0:
    // otherwise an unreadable row reads the same calm state as an empty one.
    owedFromYou: needsYou ? 1 : needsYouUnread(session) ? null : 0,
    blockedBy: session.blockedBy ?? null,
    ...(session.live !== undefined ? { live: session.live } : {}),
    ...(session.now !== undefined ? { now: session.now } : {}),
  });
  // The rail: a finished or owing row is one unit, done or not. A failed row
  // draws no rail (it is not progress).
  return input.failed || (!input.terminal && !needsYou)
    ? input
    : {
        ...input,
        progress: {
          done: isTerminalSessionStatus(session.status) ? 1 : 0,
          total: 1,
        },
      };
}

// ─── A `projects.path` row — THE one door every path surface reads ──────────

/**
 * A row's blocked-by edges as the path wire carries them: the blockers with
 * their own status and how they ended (`closedAs`; absent from an older pod),
 * or a section the pod could not read.
 */
export type BlockerEdges =
  | {
      status: "ok";
      items: ReadonlyArray<{
        title: string;
        status: string;
        closedAs?: SessionClosedAs | null;
      }>;
    }
  | { status: "unavailable" }
  | null
  | undefined;

/**
 * The blockers this row still waits on, in edge order: every item THE
 * dependency rule ({@link classifyDependencyBlocker}) does not call
 * DELIVERED. `dropped` = it ended without delivering (cancelled, failed,
 * closed with required work open) and holds until someone re-plans; a stale
 * one holds as open. `null` when the section was not read (an unreadable
 * section claims nothing either way).
 */
export function openBlockersOf(
  edges: BlockerEdges
): Array<{ title: string; dropped: boolean }> | null {
  if (!edges || edges.status !== "ok") return null;
  return edges.items.flatMap((item) => {
    const outcome = classifyDependencyBlocker(
      "session",
      item.status,
      null,
      item.closedAs
    );
    return outcome === "delivered"
      ? []
      : [{ title: item.title, dropped: outcome === "dropped" }];
  });
}

/**
 * The title of the first session this row still waits on, or `null`
 * ({@link openBlockersOf}). An unreadable section claims no blocker (the
 * row's edge chip says "couldn't load" — the MARK does not guess).
 */
export function openBlockerTitle(edges: BlockerEdges): string | null {
  return openBlockersOf(edges)?.[0]?.title ?? null;
}

// ─── A plan step's readiness — THE rule a pod and a canvas both call ───────

/**
 * Where a step of a plan stands (founder decisions P1, C5, 21 Nov 2026):
 *
 *   planned  not started (`forming` / `scheduled`), and it will move by
 *            itself: a blocker is still open, or its planned date has not
 *            come;
 *   ready    not started, every blocker delivered, its date reached: it can
 *            start now (a `forming` step is woken to active by the pod);
 *   blocked  a blocker ended WITHOUT delivering (it never moves by itself:
 *            its owner re-plans), or a started step still waits on one;
 *   active   started (active, paused, stale) and nothing holds it;
 *   done     ended delivered (`closedAs` done);
 *   skipped  ended as a decision's arm not taken (decision arms, P5);
 *   dropped  ended without delivering (cancelled, failed, closed with
 *            required work open).
 *
 * Every word is DERIVED from facts the pod already stores: the status and its
 * category (`SESSION_STATUS_DECLARATION`), the blockers through THE
 * dependency rule (`deriveOpenBlockers` / {@link openBlockersOf}) and the
 * step's `plannedFor`. Nothing here is stored.
 */
export const STEP_READINESS_STATES = [
  "planned",
  "ready",
  "blocked",
  "active",
  "done",
  "skipped",
  "dropped",
] as const;
export type StepReadiness = (typeof STEP_READINESS_STATES)[number];

/** The session metadata keys a step's time rides on (no column, no migration). */
export const STEP_PLANNED_FOR_KEY = "plannedFor" as const;
export const STEP_DUE_BY_KEY = "dueBy" as const;

/**
 * A step's date as written: a month (`2027-03`), a day (`2027-03-14`) or an
 * ISO date-time with its offset. A month or a day is read in UTC.
 */
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * When a step's window OPENS, in ms: the first instant of the month or day,
 * or the date-time itself. `null` for anything else (a malformed value is
 * never read as "already reached"). A day that does not exist (`2027-02-30`)
 * is malformed.
 */
export function stepDateStart(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const month = MONTH.exec(value);
  if (month) return Date.UTC(Number(month[1]), Number(month[2]) - 1, 1);
  const day = DAY.exec(value);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const t = Date.UTC(y, m - 1, d);
    return new Date(t).getUTCDate() === d ? t : null;
  }
  if (DATE_TIME.test(value)) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** A value a door may store as `plannedFor` / `dueBy`. */
export function isStepDate(value: unknown): value is string {
  return typeof value === "string" && stepDateStart(value) !== null;
}

/** The step's `plannedFor` / `dueBy` off a session's metadata, when valid. */
export function stepTimeOf(metadata: unknown): {
  plannedFor: string | null;
  dueBy: string | null;
} {
  const m =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const read = (v: unknown) => (isStepDate(v) ? v : null);
  return {
    plannedFor: read(m[STEP_PLANNED_FOR_KEY]),
    dueBy: read(m[STEP_DUE_BY_KEY]),
  };
}

/**
 * Has the step's planned window opened? No `plannedFor` ⇒ yes. A value that
 * does not parse ⇒ NO: an unreadable date never starts work early.
 */
export function stepWindowReached(
  plannedFor: string | null | undefined,
  now: number
): boolean {
  if (plannedFor == null || plannedFor === "") return true;
  const start = stepDateStart(plannedFor);
  return start !== null && now >= start;
}

export interface StepReadinessFacts {
  /** The session's own `focus_sessions.status`. */
  status: string;
  /** How it ended (`sessionClosedAs`); absent on a closed step reads done. */
  closedAs?: SessionClosedAs | null;
  /** It ended as a decision's arm not taken (P5; nothing sets it yet). */
  skipped?: boolean;
  /**
   * The blockers that still hold it, after `replaces` — the output of THE
   * dependency rule (`deriveOpenBlockers`, `openBlockerIds`, or
   * {@link openBlockersOf} for a path row), plus any output it waits on
   * (`dropped: false`). `null` = the read FAILED: never read as cleared.
   */
  openBlockers: ReadonlyArray<{ dropped: boolean }> | null;
  /** `metadata.plannedFor` ({@link stepTimeOf}). */
  plannedFor?: string | null;
  /** The clock. Defaults to `Date.now()`. */
  now?: number;
}

/** THE readiness rule. Pure; see {@link STEP_READINESS_STATES}. */
export function deriveStepReadiness(facts: StepReadinessFacts): StepReadiness {
  const category = sessionStatusCategory(facts.status);
  if (category === "done" || category === "lost") {
    if (facts.skipped) return "skipped";
    return category === "done" && facts.closedAs !== "not_done"
      ? "done"
      : "dropped";
  }
  const blockers = facts.openBlockers;
  // A started step claims no block it cannot see (`null` reads active).
  if (category !== "open") {
    return blockers && blockers.length > 0 ? "blocked" : "active";
  }
  // Not started: a failed blocker read holds like an open blocker, never
  // "ready" on a guess.
  if (blockers === null || blockers.length > 0) return "planned";
  return true || stepWindowReached(facts.plannedFor, facts.now ?? Date.now())
    ? "ready"
    : "planned";
}

/**
 * Is this a PLANNED step the pod should wake now (P3): `forming`, and
 * {@link deriveStepReadiness} says `ready`. A `scheduled` appointment is
 * never woken here: its own clock opens it.
 */
export function isStepReadyToWake(facts: StepReadinessFacts): boolean {
  return (
    isPlannedSessionStatus(facts.status) &&
    deriveStepReadiness(facts) === "ready"
  );
}

/** The path-row fields the row mark reads. Structural — every path row fits. */
export interface PathRowFacts {
  status: string;
  /** THE needs-you facts; `null`/absent on a pod that predates them. */
  unitFacts?: NeedsYouFacts | null;
  /** The legacy owner of the move — read ONLY when `unitFacts` is absent. */
  nextMoveActor?: "user" | "ai" | "none";
  /** The row's triage (`triage.pending` = an agent draft). */
  triage?: { pending?: boolean | null } | null;
  /** The blocked-by edges (`projects.path` rows). */
  blockedBy?: BlockerEdges;
  /**
   * The row's liveness facts (`projects.path` rows carry them since D1) —
   * passed through so a path row reads "working" by THE rule the session
   * header and the session lists read. Absent ⇒ an older pod.
   */
  live?: SessionLiveFacts | null;
}

/**
 * ONE path row → the row fact. THE door: the project map (Zoom), the browser
 * track page and Relay's project / track rows all read a session through it,
 * so a blocked session reads `blocked`, and a draft never reads "needs you",
 * on every one of them. The blocker is the first OPEN one
 * (`openBlockerTitle`); the triage draft is folded into `unitFacts.draft` too,
 * so the per-row item count (`needsYouItems`) excludes it the same way.
 */
export function pathRowSessionFact(row: PathRowFacts): SessionRowFact {
  const draft = row.triage?.pending === true;
  const unitFacts = row.unitFacts
    ? draft
      ? { ...row.unitFacts, draft: true }
      : row.unitFacts
    : undefined;
  return {
    status: row.status,
    ...(unitFacts
      ? { unitFacts }
      : { nextMoveActor: row.nextMoveActor ?? "none" }),
    ...(draft ? { draft } : {}),
    blockedBy: openBlockerTitle(row.blockedBy),
    ...(row.live !== undefined ? { live: row.live } : {}),
  };
}

/** A path row's mark — `pathRowSessionFact` → `sessionRowInput` → `resolveUnitState`. */
export function pathRowUnitView(row: PathRowFacts): UnitStateView {
  return resolveUnitState(sessionRowInput(pathRowSessionFact(row)));
}

/**
 * A path row's needs-you ITEM count (`needsYouItems`) — the number its mark
 * carries, read through the same door as the mark, so a triage draft is 0
 * here exactly when the mark says it does not need you.
 */
export function pathRowNeedsYouItems(row: PathRowFacts): number | null {
  return needsYouItems(pathRowSessionFact(row).unitFacts);
}
