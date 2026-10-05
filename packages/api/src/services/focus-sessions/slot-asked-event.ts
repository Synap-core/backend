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
import type { ExpectedOutput } from "@synap/playbooks";
import { askFingerprint } from "@synap-core/types/ask";
import { logEvent } from "../../lib/event-helpers.js";
import { normalizeExpectedLabel } from "./expected-label.js";
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
