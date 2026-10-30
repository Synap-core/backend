/**
 * STUCK — THE one rule for "what is holding work up, and who has to move it"
 * ("Agents working together" plan v1 §4, decisions 11 and 12, 2026-10-22).
 *
 * A session list page (`focusSessions.list` rows with their `blockedBy` edges,
 * `unitFacts`, `nextMove` and `live` facts) → the CHAINS of work that stand
 * still. Each chain leads with its ROOT CAUSE, the one session to act on, then
 * the sessions it holds up. The Work map's side rail ("What's stuck") and the
 * Work › Stuck reading draw this; Relay, when it shows stuck work, reads the
 * same function (it consumes this package directly — no mirror).
 *
 * A root is a session that has not ended and is itself waiting, in ONE of
 * three ways, checked in this order (who has to act):
 *
 *   needs_you        it needs the person (THE needs-you rule,
 *                    `aggregateNeedsYou`: owed slot, pending decision, review;
 *                    drafts never). The person acts.
 *   blocker_dropped  it waits on a blocker that ENDED WITHOUT DELIVERING
 *                    (cancelled, failed — THE dependency rule,
 *                    `classifyDependencyBlocker`). It must re-plan: remove the
 *                    edge, or wait on the session that retries it.
 *   gone_quiet       open, held by no open blocker, and nothing recorded for
 *                    {@link SESSION_GONE_QUIET_MS} (decision 12), or `stale`
 *                    (the reaper already found it quiet). Nobody is moving it.
 *
 * A session held by an OPEN blocker is never a root: its stuckness is its
 * blocker's, and it shows up in that blocker's chain instead.
 *
 * ── Judgement calls, stated once ───────────────────────────────────────────
 *
 * **A chain must hold something, except a dropped one.** A needs-you or
 * gone-quiet root that holds no session is not "stuck work" — it is the
 * Inbox's (needs you) or nobody's (an idle session waits for its owner, and a
 * pod keeps many). A `blocker_dropped` root is listed even when nothing waits
 * on it: it is itself held, by work that will never arrive.
 *
 * **The pod's next move is the authority on "held" and "dropped".** It
 * follows `replaces` links, which a list page does not carry: a dropped
 * blocker that was replaced is no longer a re-plan, and the page alone would
 * say it still is. So when a row carries a readable `nextMove`, its kind
 * decides (`blocker_dropped` = dropped, `waiting_on_session` = held); a row
 * without one (an older pod, or `unknown`) is read from the page's edges.
 *
 * **Gone quiet needs a measured clock.** Only `live` facts that were read
 * (`turnInFlight` false and a `lastAt` older than the threshold) or a `stale`
 * status claim quiet. Absent or failed liveness, or no activity recorded yet,
 * claims nothing. A `scheduled` session waits for its time and is never quiet.
 *
 * **Held = not ended.** A dependent counts while it has not ended (open or
 * stale); a closed, cancelled or failed one is held by nothing. Dependents are
 * followed transitively (depth 1 = waits on the root directly), each once,
 * cycle-safe. A session can be held by two roots and then appears in both.
 *
 * **The page is the world.** A blocker or dependent outside the page is
 * unknown here — under-reporting, never over-reporting (the same caveat as
 * the map's `holdingSessionIds`). A cycle of open sessions blocking each
 * other has no root and is not reported.
 *
 * Pure: the clock is a parameter.
 */

import { classifyDependencyBlocker } from "../connections/dependency.js";
import { resolveSessionTitle } from "../focus-sessions/title.js";
import { isTerminalSessionStatus } from "../focus-sessions/statuses.js";
import type { SessionLiveFacts } from "../run-activity/live.js";
import type { NeedsYouFacts } from "./needs-you.js";
import { aggregateNeedsYou } from "./session.js";
import { WORK_CLOCK } from "../work-clock/index.js";

/** No recorded activity for this long ⇒ an open session has gone quiet (decision 12). */
export const SESSION_GONE_QUIET_MS = WORK_CLOCK.quiet;

/** Why a chain stands still — who has to move it. */
export type StuckCause = "needs_you" | "blocker_dropped" | "gone_quiet";

/** The causes in the order they are listed: the person first. */
export const STUCK_CAUSE_ORDER: readonly StuckCause[] = [
  "needs_you",
  "blocker_dropped",
  "gone_quiet",
];

/** What the rule reads off ONE list row. Structural — every list row fits. */
export interface StuckSessionRow {
  id: string;
  title?: string | null;
  goal?: string | null;
  /** The pod's own `focus_sessions.status`. */
  status: string;
  /** Ids of the sessions this one waits on (`blocked_by`), unfiltered. */
  blockedBy?: readonly string[] | null;
  /** THE needs-you facts, when the row carries them. */
  unitFacts?: NeedsYouFacts | null;
  /** The pod's next move: its owner (legacy needs-you) and its kind. */
  nextMove?: {
    kind?: string | null;
    actor?: "user" | "ai" | "none" | null;
    sessionId?: string | null;
  } | null;
  /** The row's triage (`triage.pending` = an agent draft). */
  triage?: { pending?: boolean | null } | null;
  /** The liveness facts. `null` = the read failed; absent = not read. */
  live?: SessionLiveFacts | null;
}

export interface StuckSessionRef {
  id: string;
  /** `resolveSessionTitle`: `""` only with no title and no goal (the caller owns that copy). */
  title: string;
  status: string;
}

export interface StuckHeldSession extends StuckSessionRef {
  /** 1 = waits on the root directly; 2 = waits on a session that does; … */
  depth: number;
}

export interface StuckChain {
  /** The session to act on. */
  root: StuckSessionRef;
  cause: StuckCause;
  /**
   * `blocker_dropped`: the blockers on the page that ended without
   * delivering. Empty when the pod named a dropped blocker the page does not
   * carry.
   */
  dropped: StuckSessionRef[];
  /** `gone_quiet`: how long nothing was recorded; `null` when not measured (a stale row). */
  quietForMs: number | null;
  /** The sessions it holds up, nearest first, each once. */
  holds: StuckHeldSession[];
}

function timeOf(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

const refOf = (row: StuckSessionRow): StuckSessionRef => ({
  id: row.id,
  title: resolveSessionTitle(row),
  status: row.status,
});

/** A readable next move — the pod's answer, which follows `replaces`. */
function knownMove(row: StuckSessionRow): string | null {
  const kind = row.nextMove?.kind;
  return kind && kind !== "unknown" ? kind : null;
}

/**
 * The chains of stuck work on this page, root cause first. See the module
 * header for the rule; `now` is the clock for the gone-quiet threshold.
 */
export function deriveStuckChains(
  rows: readonly StuckSessionRow[],
  opts: { now: number; quietAfterMs?: number }
): StuckChain[] {
  const quietAfter = opts.quietAfterMs ?? SESSION_GONE_QUIET_MS;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const blockersOf = (row: StuckSessionRow): StuckSessionRow[] =>
    (row.blockedBy ?? [])
      .filter((id) => id !== row.id)
      .map((id) => byId.get(id))
      .filter((b): b is StuckSessionRow => b !== undefined);
  const outcomeOf = (row: StuckSessionRow) =>
    classifyDependencyBlocker("session", row.status);

  // Who waits on whom, page-wide: blocker id → its live dependents.
  const dependents = new Map<string, StuckSessionRow[]>();
  for (const row of rows) {
    if (isTerminalSessionStatus(row.status)) continue;
    for (const blocker of blockersOf(row)) {
      const list = dependents.get(blocker.id) ?? [];
      if (!list.includes(row)) list.push(row);
      dependents.set(blocker.id, list);
    }
  }

  const droppedOf = (row: StuckSessionRow): StuckSessionRef[] | null => {
    const onPage = blockersOf(row).filter((b) => outcomeOf(b) === "dropped");
    const move = knownMove(row);
    if (move !== null) {
      if (move !== "blocker_dropped") return null;
      const namedId = row.nextMove?.sessionId;
      const named = namedId ? byId.get(namedId) : undefined;
      const all =
        named && !onPage.includes(named) ? [named, ...onPage] : onPage;
      return all.map(refOf);
    }
    return onPage.length > 0 ? onPage.map(refOf) : null;
  };

  const heldByOpen = (row: StuckSessionRow): boolean => {
    const move = knownMove(row);
    if (move !== null) return move === "waiting_on_session";
    return blockersOf(row).some((b) => outcomeOf(b) === "open");
  };

  const quietFor = (row: StuckSessionRow): number | null | false => {
    if (row.status === "stale") {
      const last = timeOf(row.live?.lastAt);
      return last === null ? null : Math.max(0, opts.now - last);
    }
    if (row.status === "scheduled" || !row.live || row.live.turnInFlight) {
      return false;
    }
    const last = timeOf(row.live.lastAt);
    if (last === null) return false;
    const idle = opts.now - last;
    return idle >= quietAfter ? idle : false;
  };

  const holdsOf = (root: StuckSessionRow): StuckHeldSession[] => {
    const out: StuckHeldSession[] = [];
    const seen = new Set<string>([root.id]);
    let frontier = [root];
    for (let depth = 1; frontier.length > 0; depth += 1) {
      const next: StuckSessionRow[] = [];
      for (const blocker of frontier) {
        for (const dependent of dependents.get(blocker.id) ?? []) {
          if (seen.has(dependent.id)) continue;
          seen.add(dependent.id);
          out.push({ ...refOf(dependent), depth });
          next.push(dependent);
        }
      }
      frontier = next;
    }
    return out;
  };

  const chains: StuckChain[] = [];
  for (const row of rows) {
    if (isTerminalSessionStatus(row.status)) continue;
    const draft = row.triage?.pending === true;
    const needsYou = aggregateNeedsYou({
      status: row.status,
      ...(row.unitFacts ? { unitFacts: row.unitFacts } : {}),
      nextMoveActor: row.nextMove?.actor ?? "none",
      ...(draft ? { draft } : {}),
    });
    if (needsYou) {
      const holds = holdsOf(row);
      if (holds.length > 0) {
        chains.push({
          root: refOf(row),
          cause: "needs_you",
          dropped: [],
          quietForMs: null,
          holds,
        });
      }
      continue;
    }
    const dropped = droppedOf(row);
    if (dropped) {
      chains.push({
        root: refOf(row),
        cause: "blocker_dropped",
        dropped,
        quietForMs: null,
        holds: holdsOf(row),
      });
      continue;
    }
    if (heldByOpen(row)) continue;
    const quiet = quietFor(row);
    if (quiet === false) continue;
    const holds = holdsOf(row);
    if (holds.length > 0) {
      chains.push({
        root: refOf(row),
        cause: "gone_quiet",
        dropped: [],
        quietForMs: quiet,
        holds,
      });
    }
  }

  const rank = (c: StuckCause) => STUCK_CAUSE_ORDER.indexOf(c);
  return chains.sort(
    (a, b) =>
      rank(a.cause) - rank(b.cause) ||
      b.holds.length - a.holds.length ||
      a.root.title.localeCompare(b.root.title) ||
      a.root.id.localeCompare(b.root.id)
  );
}
