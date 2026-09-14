/**
 * The ONE derivation of a capture's status (raw-capture contract §4).
 *
 * Status is never stored: it is read off three facts that already exist — an
 * OPEN `capture_question` part in the source's session room, the intake
 * source's `degraded` marker, and how many entities the source produced. The
 * list, the `status` filter and the detail read all call this one function.
 *
 * ORDER IS THE RULE. An open question beats everything (the user owes an
 * answer). Then the degraded marker beats a produced item.
 *
 * Founder decision, 2026-09-14: a capture ALWAYS creates something by default,
 * with or without AI. When the AI is down, the fallback is a note. That note is
 * produced, yet no AI ran, so the list must still say "Saved without AI" and keep
 * offering Structure again.
 *
 * The marker is honest for this: `stageIntakeSource` clears it only when a later
 * NON-degraded staging of the same raw succeeds (it records `restructuredAt`). A
 * degraded retry keeps it. So once a real AI run structures the raw, the status
 * becomes "structured".
 */

export const CAPTURE_STATUSES = [
  "structured",
  "saved_without_ai",
  "needs_answer",
  "not_structured",
] as const;

export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export function deriveCaptureStatus(facts: {
  hasOpenQuestion: boolean;
  degraded: boolean;
  producedCount: number;
}): CaptureStatus {
  if (facts.hasOpenQuestion) return "needs_answer";
  if (facts.degraded) return "saved_without_ai";
  if (facts.producedCount > 0) return "structured";
  return "not_structured";
}
