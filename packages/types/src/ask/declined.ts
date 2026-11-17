/**
 * REFUSE — the person's no to an agent's ask (founder, 16 Nov 2026, plan
 * d717d6ac §3, finding 427c440c). The zod-free leaf of the rule.
 *
 * A refusal is one more ANSWER VALUE, `{ type: "declined", reason? }`, taken
 * by the one person-only answer door for EVERY ask mode (confirm, choose,
 * form, act, provide) and for a slot with no ask. It is input to the agent,
 * never a delivery:
 *   - the slot goes back to the agent with the answer on it, the
 *     `slot_answered` event, a room line said as the person and a wake;
 *   - the thing the slot holds up STAYS blocked (`blocks` is kept);
 *   - nothing is granted: no secret read, no run param, no draft taken on,
 *     no decision filed, no criterion graded;
 *   - the SAME ask (same `askFingerprint`) is refused at every ask door while
 *     the refusal stands, so the agent never silently asks again.
 *
 * WHY HERE and not in `./index.ts`: the deliverable rule
 * (`../units/deliverable.ts`) must tell a refusal from a decision, and the
 * units leaf never reaches `zod`. This module reads stored answers
 * structurally and imports only the vocabulary door.
 */

import { resolveActionLabel } from "../vocabulary/index.js";

/** The answer value's discriminator for a refusal. */
export const DECLINED_ANSWER_TYPE = "declined" as const;

function recordOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Is this answer VALUE a refusal? Structural: any stored shape is safe. */
export function isDeclinedValue(value: unknown): boolean {
  return recordOf(value)?.type === DECLINED_ANSWER_TYPE;
}

/**
 * Is this stored ANSWER (`SlotAnswer`, a slot's `answer`) a refusal? The one
 * reader every rule calls: decided, met, owed, re-ask.
 */
export function isDeclinedAnswer(answer: unknown): boolean {
  return isDeclinedValue(recordOf(answer)?.value);
}

/** The person's reason, trimmed; `null` when they gave none. */
export function declinedReasonOf(answer: unknown): string | null {
  const value = recordOf(recordOf(answer)?.value);
  if (value?.type !== DECLINED_ANSWER_TYPE) return null;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  return reason || null;
}

/**
 * The refusal as words: "Refused", or "Refused: <reason>". It is the
 * answer's summary (`SlotAnswer.text`, what the room post says and what the
 * agent reads), so the receipt and the agent read the same line. The verb
 * comes through the vocabulary door (`refuse`, past mood).
 */
export function declinedAnswerText(reason?: string | null): string {
  const head = resolveActionLabel("refuse", "past");
  const why = typeof reason === "string" ? reason.trim() : "";
  return why ? `${head}: ${why}` : head;
}
