/**
 * ONE reader for a capture `followUp`.
 *
 * WHY THIS FILE EXISTS. `capture.structure` can answer with a CLARIFYING
 * QUESTION instead of entities (`capture.ts` — `followUp`, passed through
 * before dedup). Surfacing that on the agent doors meant narrowing the same
 * `string | StructuredFollowUp` union in two places, and both doors ended up
 * with a hand-rolled copy of the narrowing AND the same fallback sentence
 * verbatim. Two copies of one shape is how the doors start disagreeing about
 * what "needs input" means — and the shape is already typed
 * (`StructuredFollowUp`), so neither copy was earning anything.
 *
 * Each door keeps its OWN response envelope and its own prose; only the
 * narrowing lives here.
 */

/** The shared default when the structurer asked for input but named no question. */
export const CAPTURE_FOLLOW_UP_FALLBACK =
  "The structurer needs one clarification before this can be captured.";

export interface ReadFollowUpResult {
  /** The question to put to the user. Never empty — falls back to the constant. */
  question: string;
  /** Structured answer chips when the structurer supplied them. */
  suggestions: unknown[] | undefined;
}

/**
 * Narrow a raw `followUp` off a structure result.
 *
 * Returns `null` when there is no follow-up — callers MUST treat that as "carry
 * on", never as "ask an empty question".
 */
export function readCaptureFollowUp(raw: unknown): ReadFollowUpResult | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const question = raw.trim();
    return {
      question: question.length > 0 ? question : CAPTURE_FOLLOW_UP_FALLBACK,
      suggestions: undefined,
    };
  }
  if (typeof raw !== "object") return null;
  const asked = (raw as { question?: unknown }).question;
  const suggestions = (raw as { suggestions?: unknown }).suggestions;
  return {
    question:
      typeof asked === "string" && asked.trim().length > 0
        ? asked
        : CAPTURE_FOLLOW_UP_FALLBACK,
    suggestions: Array.isArray(suggestions) ? suggestions : undefined,
  };
}
