/**
 * The durable record of an ask AS POSED — `focus_session.slot_asked.completed`.
 *
 * Every door that can hand a slot to the person with a typed `ask`
 * (`blockExpectedOutput`, the wholesale `updateFocusSession` patch, the
 * decision-ask reactor) diffs the slot array it wrote against the one it read
 * and logs one row per NEWLY posed ask. "Newly" is the ask's fingerprint
 * changing on a human-owned slot: re-sending the same ask is not a second
 * question.
 *
 * NOT SILENT ON FAILURE: the write it records has already landed, so a failed
 * append must not fail the caller — but it is logged at error level, never
 * swallowed (the "empty vs failed" rule).
 */

import { createLogger } from "@synap-core/core";
import type { ExpectedOutput, SlotAskCause } from "@synap/playbooks";
import {
  askFingerprint,
  effectiveSlotUnblocks,
  type AskCardSlot,
} from "@synap-core/types/ask";
import { logEvent } from "../../lib/event-helpers.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import { isOwedSlot } from "./owed-outputs.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
} from "./lifecycle-events.js";

const logger = createLogger({ module: "slot-asked-event" });

/** Human-owned slots in `after` whose ask is new or changed vs `before`. Pure. */
export function newlyAskedSlots(
  before: readonly ExpectedOutput[],
  after: readonly ExpectedOutput[]
): ExpectedOutput[] {
  const prior = new Map<string, ExpectedOutput>();
  for (const o of before) {
    const key = normalizeExpectedLabel(o?.label);
    if (key && !prior.has(key)) prior.set(key, o);
  }
  return after.filter((o) => {
    if (!o || o.owner !== "human" || !o.ask) return false;
    const was = prior.get(normalizeExpectedLabel(o.label) ?? "");
    if (!was || was.owner !== "human" || !was.ask) return true;
    return askFingerprint(was.ask) !== askFingerprint(o.ask);
  });
}

/**
 * WHO asked a write's newly posed slots — the acting door's verified agent, or
 * the system cause a producer no agent drives names. Both absent ⇒ the person
 * handed it to themselves, and the card names nobody.
 */
export interface AskProvenance {
  askedBy?: string | null;
  askCause?: SlotAskCause | null;
}

/**
 * Stamp `askedBy` / `askCause` on every slot this write newly POSED to the
 * person: newly owed, or still owed with a changed ask (the `slot_asked`
 * rule, {@link newlyAskedSlots}, widened to an ask-less hand-off — "Claude
 * Code handed you this" is as true without a typed ask). A slot posed anew is
 * stamped from THIS write only: an earlier asker never rides onto a question
 * it did not ask. Every other slot keeps what it carried (the merge carries
 * the stamp, `reconcileOwedSince` drops it with the ownership). Pure.
 *
 * The ONE stamp for every door that hands a slot to the person
 * (`blockExpectedOutput`, `applyOutputMutations`, the room question, the
 * system producers), so the asker the card names is the agent the event
 * records.
 */
export function stampAskProvenance(
  before: readonly ExpectedOutput[],
  after: readonly ExpectedOutput[],
  provenance: AskProvenance
): ExpectedOutput[] {
  const posedNow = posedBy(before);
  const askedBy = provenance.askedBy?.trim() || undefined;
  const askCause = provenance.askCause ?? undefined;
  return after.map((o) => {
    if (!posedNow(o)) return o;
    const { askedBy: _was, askCause: _wasCause, ...rest } = o;
    return {
      ...rest,
      ...(askedBy ? { askedBy } : {}),
      ...(askCause ? { askCause } : {}),
    };
  });
}

/**
 * "Is this slot of `after` newly POSED to the person by the write that turned
 * `before` into it?" — newly owed, or still owed with a changed ask. THE rule
 * `stampAskProvenance` stamps by and `slotsMissingUnblocks` checks by.
 */
function posedBy(
  before: readonly ExpectedOutput[]
): (o: ExpectedOutput | null | undefined) => o is ExpectedOutput {
  const prior = new Map<string, ExpectedOutput>();
  for (const o of before) {
    const key = normalizeExpectedLabel(o?.label);
    if (key && !prior.has(key)) prior.set(key, o);
  }
  return (o): o is ExpectedOutput => {
    if (!o || typeof o !== "object" || !isOwedSlot(o)) return false;
    const was = prior.get(normalizeExpectedLabel(o.label) ?? "");
    return (
      !was ||
      !isOwedSlot(was) ||
      askFingerprint(was.ask ?? null) !== askFingerprint(o.ask ?? null)
    );
  };
}

/**
 * The slots an AGENT's write newly hands the person WITHOUT saying what the
 * answer unblocks (decision E, needs-truth §5) — their labels; empty = the
 * write may land. A slot whose cause names it (`askCause`: a system producer)
 * reads its line from the cause (`effectiveSlotUnblocks`) and is never
 * missing. Pure; the doors refuse on a non-empty answer.
 */
export function slotsMissingUnblocks(
  before: readonly ExpectedOutput[],
  after: readonly ExpectedOutput[]
): string[] {
  const posedNow = posedBy(before);
  return after
    .filter(
      (o): o is ExpectedOutput =>
        posedNow(o) && !effectiveSlotUnblocks(o as AskCardSlot)
    )
    .map((o) => o.label);
}

/** The refusal sentence for {@link slotsMissingUnblocks}. Says nothing landed. */
export function unblocksRequiredMessage(labels: readonly string[]): string {
  const named = labels.map((l) => `"${l}"`).join(", ");
  return `NOTHING WAS CHANGED: say what the person's answer unblocks. Add \`unblocks\` (one line: the next step, session or PR that waits on the answer, e.g. "the EU launch deploy") to ${named}, then send it again.`;
}

/** The event payload for one posed ask. Pure. */
export function slotAskedEventData(
  sessionId: string,
  slot: ExpectedOutput,
  askedByAgentUserId: string | null
): Record<string, unknown> {
  return {
    sessionId,
    expectedLabel: slot.label,
    kind: slot.kind,
    blockedReason: slot.blockedReason ?? null,
    why: slot.why ?? null,
    ask: slot.ask ?? null,
    askFingerprint: askFingerprint(slot.ask ?? null),
    askedByAgentUserId,
    ...(slot.decisionId ? { decisionId: slot.decisionId } : {}),
  };
}

/** Log one `slot_asked` row per newly posed ask. Never throws. */
export async function logSlotsAsked(p: {
  userId: string;
  sessionId: string;
  before: readonly ExpectedOutput[];
  after: readonly ExpectedOutput[];
  agentUserId?: string | null;
}): Promise<number> {
  const asked = newlyAskedSlots(p.before, p.after);
  for (const slot of asked) {
    try {
      await logEvent(
        p.userId,
        FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
        slotAskedEventData(p.sessionId, slot, p.agentUserId ?? null),
        {
          subjectId: p.sessionId,
          subjectType: FOCUS_SESSION_SUBJECT_TYPE,
          source: p.agentUserId ? "intelligence" : "api",
        }
      );
    } catch (err) {
      logger.error(
        { err, sessionId: p.sessionId, label: slot.label },
        "slot_asked history row FAILED to append — the ask is on the slot, but its posed form is not recorded"
      );
    }
  }
  return asked.length;
}
