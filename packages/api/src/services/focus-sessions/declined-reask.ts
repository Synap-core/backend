/**
 * The RE-ASK GUARD of a refusal (plan d717d6ac §3, finding 427c440c).
 *
 * The person refused an ask (`{ type: "declined" }`, `@synap-core/types/ask`
 * `declined.ts`): the slot came back to the agent with the answer and the
 * fingerprint of the ask refused (`SlotAnswer.askFingerprint`, stamped by
 * `answer-slot.ts`). While that answer stands, handing the slot back to the
 * person with the SAME ask is refused at every ask door, so an agent can never
 * silently ask again what the person just said no to:
 *   - the targeted block door (`blockExpectedOutput`, and through it the room
 *     question, the stage runner and the run asks);
 *   - the wholesale patch (`updateFocusSession`: `update_session` outcomes,
 *     `synap_ask_person`, Hub PATCH).
 * A CHANGED ask goes through: the re-block archives the refusal to
 * `answerHistory`, where the card can show it beside the new question.
 *
 * "The same ask" is `askFingerprint` of the slot's EFFECTIVE ask as it would
 * be stamped (`effectiveSlotAsk`: a decision slot with no ask asks its
 * derived confirm), the same fingerprint the answer door compared the refusal
 * against. Pure.
 */

import {
  askFingerprint,
  effectiveSlotAsk,
  isDeclinedAnswer,
} from "@synap-core/types/ask";

/** The refusal an identical re-ask gets, for the agent (never a person). */
export const DECLINED_REASK_MESSAGE =
  "The person refused this exact ask, and their answer stands. Do not ask it again: read their reason (answer.value.reason), then do the work another way, change the ask so it asks something new, withdraw the slot (retireOutput), or close the session failed.";

/** The slot fields the guard reads, structural over `ExpectedOutput`. */
export interface ReaskSlotLite {
  label: string;
  kind?: string | null;
  owner?: string | null;
  blockedReason?: string | null;
  why?: string | null;
  ask?: unknown;
  answer?: unknown;
}

/**
 * Is `next` (the slot as a door would stamp it, handed to the person) the
 * very ask the person refused on `stored`? Only while the refusal STANDS:
 * the stored slot is not the person's (it was handed back) and its current
 * answer is the refusal.
 */
export function isIdenticalReaskOfDecline(
  stored: ReaskSlotLite | null | undefined,
  next: ReaskSlotLite
): boolean {
  if (!stored || stored.owner === "human") return false;
  if (next.owner !== "human") return false;
  if (!isDeclinedAnswer(stored.answer)) return false;
  const refused = (stored.answer as { askFingerprint?: unknown })
    .askFingerprint;
  if (typeof refused !== "string" || refused === "") return false;
  const asked = effectiveSlotAsk(
    next as Parameters<typeof effectiveSlotAsk>[0]
  );
  return (
    askFingerprint((asked ?? null) as Parameters<typeof askFingerprint>[0]) ===
    refused
  );
}

/** The guard's refusal over several slots, naming them (at most 5). */
export function declinedReaskError(labels: string[]): string {
  const named = labels
    .slice(0, 5)
    .map((l) => `"${l}"`)
    .join(", ");
  return `Refused: ${named}: ${DECLINED_REASK_MESSAGE} Nothing was changed.`;
}
