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
 * 1. OUTSTANDING — still owed at all: not DELIVERED, not retired, and
 *    not OPTIONAL. Delivered is `done` stamped by its door, OR a decision the
 *    person answered and the pod filed ({@link isDecidedByAnswer}: founder,
 *    2 Nov 2026, "an answer that filed its decision IS the proof"). An optional slot (`optional: true`, declared at its birth —
 *    e.g. a milestone invoice an `at-close` engagement never produces) is owed
 *    by NOBODY: no needs-you row, no reaper hold, never an unmet required
 *    outcome. Filled, it is `done` like any other and counts as produced.
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
 *   stamped done, or decided by answer  → terminal       → done
 *   retired                             → terminal       → done (as a
 *       cancelled run is: it stopped; nobody is waiting on it. The receipt
 *       stays readable on the slot — the mark is not where it lives.)
 *   claimed done, not yet stamped       → a decision     → needs_review
 *       (a JUDGEMENT of the agent's claim, whoever owns the slot — it
 *       outranks the owner: the act asked is "check this", not "make this")
 *   the person's                        → owed from you  → needs_you
 *   the person refused its ask          → blocked on "Refused: …" → blocked
 *   handed back by its delegate         → blocked on the reason → blocked
 *   the session's, session still open   → running        → working
 *   the session's, session finished     → never started  → not_started
 *
 * It returns a tone + glyph like every other unit — never a colour and never a
 * sentence. The blocker's WORDS stay with the vocabulary
 * (`resolveBlockedReasonLabel`); this answers only where the slot stands.
 */

import { CRITERION_SLOT_KIND } from "../focus-sessions/criterion-slot.js";
import type { LifecycleCategory } from "../lifecycle/option.js";
import {
  declinedAnswerText,
  declinedReasonOf,
  isDeclinedAnswer,
} from "../ask/declined.js";
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
  /** Declared at birth: produce it if it applies, never owe it. */
  optional?: boolean | null;
  /** The slot's kind (`criterion` = an escalated grade, never a decision). */
  kind?: string | null;
  /** Set on an escalated criterion's grade slot. */
  criterionKey?: string | null;
  /** The `decision` entity the person's answer filed (or the ask was opened for). */
  decisionId?: string | null;
  /** The person's answer; `askSnapshot.mode` is the ask it answered. Opaque. */
  answer?: unknown;
}

/** The ask modes whose answer IS a decision (the answer door files one). */
export const DECIDING_ASK_MODES = ["confirm", "choose"] as const;

/**
 * The person answered a confirm / choose on this slot and the pod filed its
 * `decision` — the answer IS the proof the slot asked for (founder, 2 Nov
 * 2026). Three facts, all stored on the slot by the answer door:
 *   - `decisionId`: the decision exists (the filing stamps it; a FAILED
 *     filing stamps nothing, so the slot stays owed and says so);
 *   - `answer`: the person's answer is on the slot NOW (a re-ask archives it
 *     to `answerHistory`, a relay the person corrected drops it — either way
 *     the slot is owed again);
 *   - `answer.askSnapshot.mode` is `confirm` / `choose`: the ask the answer
 *     was given to is one that files a decision (a form, an act, a provide or
 *     words with no ask file none).
 * A criterion's grade slot never counts, though its ask is a choose: it is a
 * verdict on the agent's work, discharged by the grade door, not a decision.
 * A REFUSAL never counts either (`answer.value.type === "declined"`,
 * `../ask/declined.ts`): the person said no to the ask, which decides
 * nothing, so the slot stays owed (by the agent, after the hand-back). A
 * decision ask OPENED FOR a decision already carries `decisionId` before any
 * answer, which is why the value is read, not only the filing.
 *
 * READ-TIME, so a slot answered before the rule existed reads delivered too,
 * and a re-answer or a relay correction moves it with no second write. The
 * SQL mirror is `owed-slot-predicate.ts` (`@synap/database`), held to this by
 * its PGlite parity test: change both or neither.
 */
export function isDecidedByAnswer(
  slot: Pick<
    DeliverableFacts,
    "kind" | "criterionKey" | "decisionId" | "answer"
  >
): boolean {
  if (typeof slot.decisionId !== "string" || slot.decisionId === "") {
    return false;
  }
  if (slot.kind === CRITERION_SLOT_KIND) return false;
  if (typeof slot.criterionKey === "string" && slot.criterionKey !== "") {
    return false;
  }
  const answer = slot.answer;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return false;
  }
  if (isDeclinedAnswer(answer)) return false;
  const snapshot = (answer as { askSnapshot?: unknown }).askSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  const mode = (snapshot as { mode?: unknown }).mode;
  return (DECIDING_ASK_MODES as readonly unknown[]).includes(mode);
}

/**
 * Delivered: stamped `done` by its door, or decided by the person's answer
 * ({@link isDecidedByAnswer}). THE "is it delivered" question every reader
 * asks — the outstanding floor, the tallies, the outcome projection.
 */
export function isDeliverableDelivered(
  slot: Pick<
    DeliverableFacts,
    "status" | "kind" | "criterionKey" | "decisionId" | "answer"
  >
): boolean {
  return slot.status === "done" || isDecidedByAnswer(slot);
}

/** The fields the outstanding floor reads. */
type FloorFacts = Pick<
  DeliverableFacts,
  | "status"
  | "retiredAt"
  | "optional"
  | "kind"
  | "criterionKey"
  | "decisionId"
  | "answer"
>;

/** Who an outstanding deliverable is owed by. */
export type DeliverableOwedBy = "you" | "session";

/**
 * Still owed at all — not delivered (done, or decided by the person's
 * answer), not retired, not optional. THE floor: every "owed" reader
 * (needs-you, tallies, reapers via the SQL mirror, the stage gate via
 * `outcome.ts`'s `required`, the close gate) derives from it.
 */
export function isDeliverableOutstanding(slot: FloorFacts): boolean {
  // `retiredAt == null`, never `!retiredAt`: the pod's SQL mirror reads
  // `slot->>'retiredAt' IS NULL`, so a stamped-but-empty `""` is RETIRED there.
  // A falsy test here read it as still owed, and the row's TS tally then
  // disagreed with the SQL owed count on the same `projects.path` row.
  // `optional !== true`, never `!optional`: the SQL mirror reads
  // `slot->>'optional' IS DISTINCT FROM 'true'` — only a real `true` lets go.
  return (
    !isDeliverableDelivered(slot) &&
    slot.retiredAt == null &&
    slot.optional !== true
  );
}

/**
 * An optional slot nobody has filled — not delivered, not retired. Owed by
 * nobody (see the floor above), and not done either: it reads `not_started`.
 */
export function isUnfilledOptional(slot: FloorFacts): boolean {
  return (
    slot.optional === true &&
    !isDeliverableDelivered(slot) &&
    slot.retiredAt == null
  );
}

/**
 * Who owes this deliverable — `null` when it is owed by nobody (done or
 * retired). `"you"` and `"session"` PARTITION the outstanding set: every
 * surviving slot lands in exactly one, so a silent drop is impossible by
 * construction.
 */
export function deliverableOwedBy(
  slot: FloorFacts & Pick<DeliverableFacts, "owner">
): DeliverableOwedBy | null {
  if (!isDeliverableOutstanding(slot)) return null;
  return slot.owner === "human" ? "you" : "session";
}

/**
 * A slot's STATUS as a transition subject (reactions W1): DERIVED from the
 * owed rule above, never stored — a slot has no status column, and gets none.
 * The doors that change it (answer, block, unblock, satisfy, attest, retire,
 * delegate, the decision-ask reactor) owe a `slot` transition when this value
 * changes (`oweSlotTransitions`, @synap/database).
 *
 *   owed      outstanding and the person's (`deliverableOwedBy` = you): the
 *             ask is open;
 *   pending   outstanding and the session's, never answered; or optional and
 *             unfilled (owed by nobody, not made either);
 *   answered  the person answered it and it went back to the session, which
 *             still owes the slot (an answer that filed its decision is
 *             already `done`);
 *   done      delivered (`isDeliverableDelivered`);
 *   retired   let go without being delivered (`retiredAt`).
 */
export const SLOT_STATUSES = [
  "owed",
  "pending",
  "answered",
  "done",
  "retired",
] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

/**
 * THE slot lifecycle (founder decision D9, 17 Nov 2026): owed = open,
 * answered or done = done, retired = lost. A slot the session owes is `open`
 * too: it is owed, by the agent.
 */
export const SLOT_STATUS_DECLARATION = {
  owed: { category: "open" },
  pending: { category: "open" },
  answered: { category: "done" },
  done: { category: "done" },
  retired: { category: "lost" },
} as const satisfies Record<SlotStatus, { category: LifecycleCategory }>;

/** The fields {@link slotStatusOf} reads. */
export type SlotStatusFacts = FloorFacts & Pick<DeliverableFacts, "owner">;

/** One slot → its derived status. Delivered wins over retired, as the floor reads it. */
export function slotStatusOf(slot: SlotStatusFacts): SlotStatus {
  if (isDeliverableDelivered(slot)) return "done";
  if (slot.retiredAt != null) return "retired";
  if (deliverableOwedBy(slot) === "you") return "owed";
  const answer = slot.answer;
  const answered =
    answer != null &&
    (typeof answer !== "object" || Object.keys(answer).length > 0);
  return answered ? "answered" : "pending";
}

/**
 * A slot's transition subject id: `<session id>/<slot key>` (the label when
 * the slot has no key) — the `answer:` wait's spelling without its prefix, so
 * a hold may wait on `slot:<session id>/<key>`.
 */
export function slotSubjectId(
  sessionId: string,
  slot: { key?: string | null; label?: string | null }
): string | null {
  const name = slot.key || slot.label;
  return name ? `${sessionId}/${name}` : null;
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
  // Before the floor: owed by nobody, but NOT finished — it was never made.
  // A claim on it is still a claim to check (the mark only — no one owes it).
  if (isUnfilledOptional(slot)) {
    return slot.claimedDone ? { pendingDecisions: 1 } : { everStarted: false };
  }
  const owedBy = deliverableOwedBy(slot);
  if (owedBy === null) return { terminal: true };
  if (slot.claimedDone) return { pendingDecisions: 1 };
  if (owedBy === "you") return { owedFromYou: 1 };
  // The person REFUSED the ask: the agent owes a new plan, and the slot says
  // why it is stuck, on an open session and a finished one alike (a refused
  // slot of a closed session must not read "never started").
  if (isDeclinedAnswer(slot.answer)) {
    return { blockedBy: declinedAnswerText(declinedReasonOf(slot.answer)) };
  }
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
  /** Delivered: stamped done, or decided by the person's answer. */
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
    if (isDeliverableDelivered(slot)) {
      done += 1;
      continue;
    }
    const by = deliverableOwedBy(slot);
    if (by === null) continue; // retired, or optional and unfilled
    owed += 1;
    if (by === "you") owedByYou += 1;
  }
  return { done, total: done + owed, owedByYou };
}
