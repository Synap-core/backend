/**
 * A DELIVERABLE (one declared `expected_outputs` slot of a session) → its
 * state, through the ONE derivation every unit of work wears.
 *
 * Three questions are asked of a slot all over the product — is it done, is it
 * owed by YOU, is it stuck — and before this module each surface answered them
 * locally: the desktop room's `outputs-board-model.ts`, Relay's
 * `session-outputs-model.ts` and `session-owed.ts`, and the pod's
 * `isOwedSlot`. They agreed only because a cross-repo tripwire compared their
 * source token for token. This is the rule they now all call.
 *
 * ── THE TWO QUESTIONS, ASKED IN THIS ORDER ─────────────────────────────────
 * 1. OUTSTANDING — still owed at all: not stamped `done` and not retired.
 *    `done` has one write door, so anything else (`pending`, absent, a value
 *    nobody has heard of) is still owed — treating an unknown status as done
 *    would under-report the work, which is the failure direction that matters.
 *    A RETIRED slot (its session was cancelled) is owed by NOBODY, whoever
 *    owned it. Retirement sits on this floor and never on one owner branch:
 *    that placement once let a retired human-owned slot fail both branches and
 *    vanish from every bucket.
 * 2. BY WHOM — asked only of what survives: `owner === "human"` is the
 *    person's; everything else, INCLUDING an absent owner (the pre-`owner`
 *    corpus), is the session's. Never `=== "agent"`: that silently drops every
 *    slot stored before the field existed.
 *
 * ── THE STATE (`deliverableUnitInput`) — one leading fact at a time ────────
 * `resolveUnitState` checks `terminal` before `owedFromYou` and `owedFromYou`
 * before `pendingDecisions`, so setting two facts would let the wrong one win.
 * This adapter sets exactly one:
 *
 *   stamped done                        → terminal       → done
 *   retired                             → terminal       → done (as a
 *       cancelled run is: it stopped; nobody is waiting on it. The receipt
 *       stays readable on the slot — the mark is not where it lives.)
 *   claimed done, not yet stamped       → a decision     → needs_review
 *       (a JUDGEMENT of the agent's claim, whoever owns the slot — it
 *       outranks the owner: the act asked is "check this", not "make this")
 *   the person's                        → owed from you  → needs_you
 *   handed back by its delegate         → blocked on the reason → blocked
 *   the session's, session still open   → running        → working
 *   the session's, session finished     → never started  → not_started
 *
 * It returns a tone + glyph like every other unit — never a colour and never a
 * sentence. The blocker's WORDS stay with the vocabulary
 * (`resolveBlockedReasonLabel`); this answers only where the slot stands.
 */

import {
  resolveUnitState,
  type UnitStateInput,
  type UnitStateView,
} from "./state.js";

/**
 * The fields of ONE declared slot this reads — structurally a subset of the
 * playbook `ExpectedOutput`, so the pod's stored entry, Relay's wire row and
 * the desktop's normalised tab all fit without a copy.
 */
export interface DeliverableFacts {
  /** `"done"` is stamped by the one door; anything else is still owed. */
  status?: string | null;
  /** WHO the board waits on. Absent ⇒ the session's (agent), never a guess. */
  owner?: string | null;
  /** The slot stopped being owed without being delivered (session cancelled). */
  retiredAt?: string | null;
  /** The agent says it produced this after all — unverified until stamped. */
  claimedDone?: boolean | null;
  /** The delegate handed it BACK, and why. */
  returnedReason?: string | null;
}

/** Who an outstanding deliverable is owed by. */
export type DeliverableOwedBy = "you" | "session";

/** Still owed at all — not stamped done, not retired. THE floor. */
export function isDeliverableOutstanding(
  slot: Pick<DeliverableFacts, "status" | "retiredAt">
): boolean {
  return slot.status !== "done" && !slot.retiredAt;
}

/**
 * Who owes this deliverable — `null` when it is owed by nobody (done or
 * retired). `"you"` and `"session"` PARTITION the outstanding set: every
 * surviving slot lands in exactly one, so a silent drop is impossible by
 * construction.
 */
export function deliverableOwedBy(
  slot: Pick<DeliverableFacts, "status" | "retiredAt" | "owner">
): DeliverableOwedBy | null {
  if (!isDeliverableOutstanding(slot)) return null;
  return slot.owner === "human" ? "you" : "session";
}

/** The session a deliverable belongs to — the one fact the slot cannot carry. */
export interface DeliverableContext {
  /**
   * The session is closed / cancelled / failed. REQUIRED: whether an agent's
   * open slot is "being worked" or "will never be" depends on it, and a
   * default would guess.
   */
  sessionTerminal: boolean;
}

/** One deliverable → the shared derivation's input. See the header for the order. */
export function deliverableUnitInput(
  slot: DeliverableFacts,
  ctx: DeliverableContext
): UnitStateInput {
  const owedBy = deliverableOwedBy(slot);
  if (owedBy === null) return { terminal: true };
  if (slot.claimedDone) return { pendingDecisions: 1 };
  if (owedBy === "you") return { owedFromYou: 1 };
  if (slot.returnedReason) return { blockedBy: slot.returnedReason };
  if (ctx.sessionTerminal) return { everStarted: false };
  return { running: true };
}

/** {@link resolveUnitState} for one deliverable. */
export function resolveDeliverableState(
  slot: DeliverableFacts,
  ctx: DeliverableContext
): UnitStateView {
  return resolveUnitState(deliverableUnitInput(slot, ctx));
}

/** A session's deliverables, counted — the progress rail and the owed badge. */
export interface DeliverableCounts {
  /** Stamped done. */
  done: number;
  /** Done + still owed. A RETIRED slot is in neither: it was let go, not delivered. */
  total: number;
  /** Still owed, and the person's (`deliverableOwedBy === "you"`). */
  owedByYou: number;
}

/** Count a session's declared slots by the same two questions. */
export function tallyDeliverables(
  slots: readonly DeliverableFacts[]
): DeliverableCounts {
  let done = 0;
  let owed = 0;
  let owedByYou = 0;
  for (const slot of slots) {
    if (slot.status === "done") {
      done += 1;
      continue;
    }
    const by = deliverableOwedBy(slot);
    if (by === null) continue; // retired
    owed += 1;
    if (by === "you") owedByYou += 1;
  }
  return { done, total: done + owed, owedByYou };
}
