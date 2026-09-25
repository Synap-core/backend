/**
 * NEEDS YOU — the ONE rule for "is this on me?" (founder decision N1,
 * 2026-09-25).
 *
 * Needs you = three populations, and nothing else:
 *   1. OWED      — slots the session handed to the person (owed human slots);
 *   2. DECISION  — proposals filed under the session, pending review;
 *   3. REVIEW    — the session finished and its next move is the person's
 *                  acceptance: the pod's `nextMove.kind === "ready_to_close"`
 *                  ("Review and close this session").
 *
 * An agent DRAFT (a session still in triage — `triage.pending`) never needs
 * you through this rule. Drafts keep their own group ("Drafts from agents");
 * accepting or discarding one is triage, not a decision owed.
 *
 * Before this existed nine surfaces answered the question four ways — owed +
 * pending only (`sessionUnitInput`), `nextMove.actor === "user"`
 * (`projectAggregateInput`, every track mark), drafts counted as yours (the
 * work map), items vs sessions. This module is the one definition; every
 * reader reduces over the same `NeedsYouFacts`, which the pod projects onto
 * each session row as `unitFacts` (`projects.path` rows, `focusSessions.list`
 * rows under `nextMove: true`).
 *
 * ── Judgement calls, stated once ───────────────────────────────────────────
 *
 * **Terminal sessions still count for OWED and DECISION.** An owed slot
 * outlives its session — only `cancelled` retires it (`owed-outputs.ts`) — and
 * a pending proposal is pending whatever became of the session that filed it.
 * The server's item count (`focusSessions.owed`, `proposals.groups`) reads them
 * with no status filter, so this rule does too. REVIEW is never terminal: the
 * pod only answers `ready_to_close` for an open session.
 *
 * **The reasons are exclusive, in this order.** `ready_to_close` is only ever
 * derived when nothing is owed or pending, so a session is counted in exactly
 * one population and the tally never double-counts.
 *
 * **A failed read is not zero.** `owedFromYou: null` / `pendingDecisions: null`
 * mean the read FAILED; the tally reports `unreadable` rather than folding it
 * into a calm zero.
 */

import type { UnitStateInput } from "./state.js";

export type NeedsYouReason = "owed" | "decision" | "review";

/** The facts the rule reads — exactly the pod's per-row `unitFacts`. */
export interface NeedsYouFacts {
  /** Slots this session owes the person. `null` = the owed read FAILED. */
  owedFromYou: number | null;
  /**
   * Pending proposals filed under this session. `null` = the read FAILED;
   * `undefined` = the caller did not read proposals (no claim either way).
   */
  pendingDecisions?: number | null;
  /**
   * The session is finished and awaits the person's review / close — the pod's
   * `nextMove.kind === "ready_to_close"`.
   */
  awaitingReview?: boolean;
  /** An agent/automation draft still in triage. Drafts never need you. */
  draft?: boolean;
}

/** Why a session needs you, or `null` when it does not. */
export function needsYouReason(facts: NeedsYouFacts): NeedsYouReason | null {
  if (facts.draft) return null;
  if ((facts.owedFromYou ?? 0) > 0) return "owed";
  if ((facts.pendingDecisions ?? 0) > 0) return "decision";
  if (facts.awaitingReview) return "review";
  return null;
}

/** Does this session need you? THE membership test. */
export function sessionNeedsYou(facts: NeedsYouFacts): boolean {
  return needsYouReason(facts) !== null;
}

/** The three item populations, counted. */
export interface NeedsYouParts {
  /** Owed slots. */
  owed: number;
  /** Pending decisions. */
  decisions: number;
  /** Sessions awaiting the person's review / close. */
  review: number;
}

/** THE item total — one sum, so no surface adds the parts its own way. */
export function needsYouTotal(parts: NeedsYouParts): number {
  return parts.owed + parts.decisions + parts.review;
}

export interface NeedsYouTally extends NeedsYouParts {
  /** Sessions that need you (each counted once, whatever its reason). */
  sessions: number;
  /** Item total: `needsYouTotal(parts)`. */
  total: number;
  /** Some row's owed or proposals read FAILED — the numbers are a floor. */
  unreadable: boolean;
}

/** Reduce a set of sessions to the needs-you parts. Drafts contribute nothing. */
export function tallyNeedsYou(rows: readonly NeedsYouFacts[]): NeedsYouTally {
  const parts: NeedsYouParts = { owed: 0, decisions: 0, review: 0 };
  let sessions = 0;
  let unreadable = false;
  for (const row of rows) {
    if (row.draft) continue;
    if (row.owedFromYou === null || row.pendingDecisions === null) {
      unreadable = true;
    }
    parts.owed += row.owedFromYou ?? 0;
    parts.decisions += row.pendingDecisions ?? 0;
    const reason = needsYouReason(row);
    if (reason === "review") parts.review += 1;
    if (reason) sessions += 1;
  }
  return { ...parts, sessions, total: needsYouTotal(parts), unreadable };
}

/**
 * The project header's ONE state mark, given the pod's per-project needs-you
 * COUNT (`signals.count` / `countByProject`) beside the aggregate over the
 * loaded rows. A counted item the rows cannot see (a decision filed on the
 * project, an owed slot past the loaded page) must still read "needs you" —
 * so a positive count wins unless the rows already say so. A null/zero count
 * changes nothing (unmeasured is not "nothing waiting"). Shared so the desktop
 * and the phone can never paint the same project two ways.
 */
export function withProjectNeedsYouCount(
  aggregate: UnitStateInput,
  count: number | null | undefined
): UnitStateInput {
  if (count && count > 0 && !((aggregate.owedFromYou ?? 0) > 0)) {
    return { owedFromYou: count, progress: aggregate.progress ?? null };
  }
  return aggregate;
}
