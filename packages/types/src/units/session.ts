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
import type { UnitStateInput } from "./state.js";

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

  return {
    failed: facts.status === "failed",
    // `failed` is terminal too, but the derivation checks `failed` first.
    terminal: isTerminalSessionStatus(facts.status),
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
  /** The pod's own next-move owner for this session (`nextMove.actor`). */
  nextMoveActor: "user" | "ai" | "none";
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
 *   1. any session needs you     → `owedFromYou`
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

  const needsYou = input.sessions.filter(
    (s) => s.nextMoveActor === "user"
  ).length;
  const closed = input.sessions.filter((s) =>
    isTerminalSessionStatus(s.status)
  ).length;
  const progress = { done: closed, total };

  if (needsYou > 0) return { owedFromYou: needsYou, progress };
  if (closed === total) return { terminal: true, progress };
  return { running: true, everStarted: true, progress };
}

/**
 * The same reduction for ONE session row — with one deliberate difference: a
 * terminal row is `done`, full stop. Owed slots outlive their session, and the
 * pod reports `actor: "user"` for them before it consults terminal; reusing the
 * aggregate verbatim drew "Needs you" on a closed session. The obligation
 * belongs to the project's needs-you section, not to the finished row.
 */
export function sessionRowInput(
  session: ProjectAggregateSessionFact
): UnitStateInput {
  if (isTerminalSessionStatus(session.status)) {
    return { terminal: true, progress: { done: 1, total: 1 } };
  }
  return projectAggregateInput({ sessions: [session], unreadable: false });
}
