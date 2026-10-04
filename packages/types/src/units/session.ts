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
 * **`stale` maps to `unreadable`, not to working.** The reaper stamps `stale`
 * because nothing could be observed happening. `unreadable` yields `unmeasured`,
 * the honest reading; the default arm would have claimed `working`.
 *
 * **`pendingDecisions` is three-valued.** `undefined` = the caller did not read
 * proposals (no claim either way), `null` = the read FAILED (→ `unmeasured`
 * unless something live outranks it), a number = the count.
 */

import { isTerminalSessionStatus } from "../focus-sessions/statuses.js";
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

/** Lifecycle statuses meaning a person or agent is actively in the session. */
const RUNNING_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "forming",
]);
/** The two the pod expresses as a lifecycle state rather than as a cron. */
const CADENCE_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "scheduled",
  "paused",
]);

export interface SessionUnitFacts {
  /** The pod's own `focus_sessions.status`. */
  status: string;
  /**
   * Slots this session owes THE PERSON. REQUIRED: `null` means the owed read
   * FAILED, which is not zero.
   */
  owedFromYou: number | null;
  /** Pending proposals filed under this session. See the header. */
  pendingDecisions?: number | null;
  /** Title of the session this one waits on, when it is blocked. */
  blockedBy?: string | null;
  /** 0–100 as stored on the row. */
  progress?: number | null;
  /** A cadence the pod stored, when it stored one. */
  cron?: string | null;
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
  // failed read) claims nothing owed, so it stays terminal.
  const owesYou =
    (facts.owedFromYou ?? 0) > 0 || (facts.pendingDecisions ?? 0) > 0;
  return {
    failed: facts.status === "failed",
    // `failed` is terminal too, but the derivation checks `failed` first.
    terminal: isTerminalSessionStatus(facts.status) && !owesYou,
    owedFromYou: facts.owedFromYou,
    pendingDecisions: facts.pendingDecisions,
    blockedBy: facts.blockedBy ?? null,
    running: RUNNING_SESSION_STATUSES.has(facts.status),
    schedule: cadence,
    unreadable: facts.status === "stale",
    progress:
      typeof facts.progress === "number"
        ? { done: Math.max(0, Math.min(100, facts.progress)), total: 100 }
        : null,
  };
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
}

/** Does this session need you? `unitFacts` through the one rule, else the legacy actor. */
function aggregateNeedsYou(session: ProjectAggregateSessionFact): boolean {
  if (session.draft) return false;
  return session.unitFacts
    ? sessionNeedsYou(session.unitFacts)
    : session.nextMoveActor === "user";
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
 *   3. otherwise, something open → `running`
 *
 * ⚠️ `running` is a best-effort stand-in: no wire field says a session is
 * actively running, so "open and not waiting on you" counts as working.
 */
export function projectAggregateInput(
  input: ProjectAggregateStateInput
): UnitStateInput {
  if (input.unreadable) return { unreadable: true };

  const total = input.sessions.length;
  if (total === 0) return { everStarted: false };

  // THE rule (`needs-you.ts`): owed + pending decisions + awaiting review,
  // drafts excluded.
  const needsYou = input.sessions.filter(aggregateNeedsYou).length;
  const closed = input.sessions.filter((s) =>
    isTerminalSessionStatus(s.status)
  ).length;
  const progress = { done: closed, total };

  if (needsYou > 0) return { owedFromYou: needsYou, progress };
  if (closed === total) return { terminal: true, progress };
  return { running: true, everStarted: true, progress };
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
 * The same reduction for ONE session row, in this order:
 *   1. it needs you (THE rule — owed + decisions + review, drafts never)
 *      → `needs_you`, WHATEVER its lifecycle. A closed session that still owes
 *      you a slot or a decision is on you: `needs-you.ts` counts it (owed
 *      slots outlive their session; a pending proposal is pending whatever
 *      became of the session that filed it), Home lists it, and the row says
 *      the same (orchestrator decision, 2026-10-04). Before this, a terminal
 *      row returned `done` FIRST, so one session read ✓ on the map and
 *      "needs you" on Home.
 *   2. terminal → `done`.
 *   3. its own lifecycle (`sessionUnitInput`) — only active/forming is
 *      `working`; paused/scheduled are cadence states; `stale` is
 *      `unmeasured`; an OPEN blocker reads `blocked`.
 */
export function sessionRowInput(session: SessionRowFact): UnitStateInput {
  const aggregate = projectAggregateInput({
    sessions: [session],
    unreadable: false,
  });
  if ((aggregate.owedFromYou ?? 0) > 0) return aggregate;
  if (isTerminalSessionStatus(session.status)) {
    return { terminal: true, progress: { done: 1, total: 1 } };
  }
  // The aggregate's blanket "open ⇒ running" is right for a PROJECT, wrong
  // for one row: read the row the way a session reads itself.
  return sessionUnitInput({
    status: session.status,
    owedFromYou: 0,
    blockedBy: session.blockedBy ?? null,
  });
}

// ─── A `projects.path` row — THE one door every path surface reads ──────────

/**
 * A row's blocked-by edges as the path wire carries them: the blockers with
 * their own status, or a section the pod could not read.
 */
export type BlockerEdges =
  | {
      status: "ok";
      items: ReadonlyArray<{ title: string; status: string }>;
    }
  | { status: "unavailable" }
  | null
  | undefined;

/**
 * The title of the first OPEN session this row waits on, or `null`. Waiting
 * on a finished session is waiting on nothing; an unreadable section claims
 * no blocker (the row's edge chip says "couldn't load" — the MARK does not
 * guess).
 */
export function openBlockerTitle(edges: BlockerEdges): string | null {
  if (!edges || edges.status !== "ok") return null;
  return (
    edges.items.find((item) => !isTerminalSessionStatus(item.status))?.title ??
    null
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
