/**
 * NEEDS YOU — the ONE rule for "is this on me?" (founder decision N1,
 * 2026-09-25).
 *
 * Needs you = four populations, and nothing else:
 *   1. OWED       — slots the session handed to the person (owed human slots);
 *   2. DECISION   — proposals filed under the session, pending review;
 *   3. REVIEW     — the session finished and its next move is the person's
 *                   acceptance: the pod's `nextMove.kind === "ready_to_close"`
 *                   ("Review and close this session");
 *   4. PERMISSION — the session's agent stands at the terminal waiting on the
 *                   person (a permission dialog, a question): ONE item per
 *                   session, whatever else it owes (decision D-R1). Which
 *                   runner words count is `classifyRunnerWait`'s
 *                   (`needs-you/rule.ts`), asked through
 *                   {@link waitsOnYouAtTerminal} — the SAME clause the pod's
 *                   needs-you union (`permission-sessions.ts`) asks, so a row,
 *                   a project tally and the Inbox count one number.
 *
 * An agent DRAFT (a session still in triage — `triage.pending`) never needs
 * you through the first three. Drafts keep their own group ("Drafts from
 * agents"); accepting or discarding one is triage, not a decision owed. The
 * PERMISSION population is the exception: a coding agent opens its own
 * session (a draft nobody adopted) and its dialog blocks it all the same.
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
 * one of the first three populations. PERMISSION is the last reason (it only
 * adds a session the first three leave out), but its ITEM is counted beside
 * the others, as the pod's union counts it: a session owing 2 slots whose
 * agent waits on a dialog is 3 items, one session.
 *
 * **A failed read is not zero.** `owedFromYou: null` / `pendingDecisions: null`
 * mean the read FAILED; the tally reports `unreadable` rather than folding it
 * into a calm zero.
 */

import type { UnitStateInput } from "./state.js";
import {
  classifyRunnerWait,
  type NeedsYouRunnerFacts,
} from "../needs-you/rule.js";

export type { NeedsYouRunnerFacts };

export type NeedsYouReason = "owed" | "decision" | "review" | "permission";

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
  /**
   * An agent/automation draft still in triage. A draft never needs you
   * through owed, decision or review; its agent's terminal wait still does.
   */
  draft?: boolean;
  /**
   * The session's status and its LIVE runners' folded word (`foldRunnerState`,
   * 0384) — exactly `classifyRunnerWait`'s input. `null` = the runner read
   * FAILED; `undefined` = the caller did not read runners (no claim either
   * way, an older pod).
   */
  runnerWait?: NeedsYouRunnerFacts | null;
}

/**
 * THE per-session terminal-wait clause: the session's agent stands at the
 * terminal waiting on the person (decision D-R1), by `classifyRunnerWait`.
 * The pod's needs-you union derives its permission population from this
 * function (`permission-sessions.ts`), never from a list of its own. `false`
 * when the runners were not read or the read failed (a failed read is
 * reported by {@link needsYouItems} / {@link tallyNeedsYou}, never a claim).
 */
export function waitsOnYouAtTerminal(
  runnerWait: NeedsYouRunnerFacts | null | undefined
): boolean {
  return !!runnerWait && classifyRunnerWait(runnerWait) === "needs_you";
}

/** The REVIEW population: finished, nothing owed or pending, not a draft. */
function awaitsYourReview(facts: NeedsYouFacts): boolean {
  return (
    !facts.draft &&
    !((facts.owedFromYou ?? 0) > 0) &&
    !((facts.pendingDecisions ?? 0) > 0) &&
    facts.awaitingReview === true
  );
}

/** Why a session needs you, or `null` when it does not. */
export function needsYouReason(facts: NeedsYouFacts): NeedsYouReason | null {
  if (!facts.draft) {
    if ((facts.owedFromYou ?? 0) > 0) return "owed";
    if ((facts.pendingDecisions ?? 0) > 0) return "decision";
    if (awaitsYourReview(facts)) return "review";
  }
  if (waitsOnYouAtTerminal(facts.runnerWait)) return "permission";
  return null;
}

/** Does this session need you? THE membership test. */
export function sessionNeedsYou(facts: NeedsYouFacts): boolean {
  return needsYouReason(facts) !== null;
}

/** The item populations, counted. */
export interface NeedsYouParts {
  /** Owed slots. */
  owed: number;
  /** Pending decisions. */
  decisions: number;
  /** Sessions awaiting the person's review / close. */
  review: number;
  /**
   * Sessions whose agent waits on the person at the terminal (decision D-R1,
   * {@link waitsOnYouAtTerminal}): one item per session. Absent = not counted
   * (an older reader).
   */
  permission?: number;
}

/** THE item total — one sum, so no surface adds the parts its own way. */
export function needsYouTotal(parts: NeedsYouParts): number {
  return parts.owed + parts.decisions + parts.review + (parts.permission ?? 0);
}

/**
 * THE per-ROW needs-you number — the count a person glyph carries on ONE
 * session (a map bar, a stage card, a Zoom session card, a session header, a
 * track tally's sum). ITEMS, the unit of every needs-you number in the
 * product (`signals.count`, Home's Needs you, `tallyNeedsYou().total`): owed
 * slots + pending decisions + 1 when the session awaits your review (review
 * counted only when nothing is owed or pending, as `tallyNeedsYou` counts it)
 * + 1 when its agent waits on you at the terminal ({@link waitsOnYouAtTerminal}).
 *
 * A draft counts only its terminal wait (0 or 1). `null` when the facts were
 * not carried, or a part's read FAILED — a count of nothing is not zero.
 */
export function needsYouItems(
  facts: NeedsYouFacts | null | undefined
): number | null {
  if (!facts) return null;
  if (facts.runnerWait === null) return null;
  const permission = waitsOnYouAtTerminal(facts.runnerWait) ? 1 : 0;
  if (facts.draft) return permission;
  if (facts.owedFromYou === null || facts.pendingDecisions === null) {
    return null;
  }
  return needsYouTotal({
    owed: facts.owedFromYou,
    decisions: facts.pendingDecisions ?? 0,
    review: awaitsYourReview(facts) ? 1 : 0,
    permission,
  });
}

export interface NeedsYouTally extends NeedsYouParts {
  /** Sessions that need you (each counted once, whatever its reason). */
  sessions: number;
  /** Item total: `needsYouTotal(parts)`. */
  total: number;
  /** Some row's owed, proposals or runner read FAILED — the numbers are a floor. */
  unreadable: boolean;
}

/**
 * Reduce a set of sessions to the needs-you parts. A draft contributes only
 * its agent's terminal wait.
 */
export function tallyNeedsYou(rows: readonly NeedsYouFacts[]): NeedsYouTally {
  const parts: Required<NeedsYouParts> = {
    owed: 0,
    decisions: 0,
    review: 0,
    permission: 0,
  };
  let sessions = 0;
  let unreadable = false;
  for (const row of rows) {
    if (row.runnerWait === null) unreadable = true;
    if (waitsOnYouAtTerminal(row.runnerWait)) parts.permission += 1;
    if (needsYouReason(row)) sessions += 1;
    if (row.draft) continue;
    if (row.owedFromYou === null || row.pendingDecisions === null) {
      unreadable = true;
    }
    parts.owed += row.owedFromYou ?? 0;
    parts.decisions += row.pendingDecisions ?? 0;
    if (awaitsYourReview(row)) parts.review += 1;
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
