/**
 * The ONE derivation of a capture's status (raw-capture contract §4).
 *
 * Status is never stored: it is read off three facts that already exist — an
 * OPEN `capture_question` part in the source's session room, the intake
 * source's `degraded` marker, and how many entities the source produced. The
 * list, the `status` filter and the detail read all call this one function.
 *
 * ORDER IS THE RULE. An open question beats everything (the user owes an
 * answer); a produced item beats the degraded marker (a source that was stored
 * degraded and later structured is structured, even if the marker was never
 * cleared); only a degraded source with nothing produced is "saved without AI".
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
  if (facts.producedCount > 0) return "structured";
  if (facts.degraded) return "saved_without_ai";
  return "not_structured";
}
