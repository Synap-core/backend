/**
 * Capture narrative + raw-source bound — the ONE place both live.
 *
 * TWO defects this module closes, both measured on 2961 live proposals:
 *
 * 1. NARRATIVE. `summary` was present on 39.8% of rows and `reasoning` on
 *    34.8%, so a reviewer opening the inbox read "Proposed graph: 13 entities,
 *    17 links" — the SHAPE of the write, never what was asked for or where it
 *    came from. `submitCaptureGraph` has always accepted a real `summary`
 *    (submit-capture-graph.ts: the count string is only its `??` fallback); the
 *    producers simply did not supply one. `buildCaptureNarrativeSummary` is the
 *    shared shape they now all use, modelled on the one producer that already
 *    got it right (`webhooks-inbound.ts`: "Cal.com booking — <title>").
 *
 * 2. THE BOUND THAT WAS NOT ONE. `SubmitCaptureGraphInput.rawSource` documented
 *    itself as "Bounded original input" while `submitCaptureGraph` enforced NO
 *    bound at all — the cap was a caller CONVENTION with three different values
 *    (Hub `/capture/structure` and `webhooks-inbound` sliced at 100_000, MCP
 *    `synap_capture` at 8_000, and `builtin-verbs`' `message.interpret` did not
 *    slice at all). A comment asserting a fact nobody checks is the defect, so
 *    `RAW_SOURCE_MAX_CHARS` is now the single value, the core door ENFORCES it
 *    via `boundRawSourceText`, and the doc says what is actually true.
 *
 *    100_000 is the value kept because it is the only one that was ever
 *    ENFORCED — `CaptureGraphRawSourceSchema` (rest/_codecs/misc.ts) REJECTS
 *    above it. Adopting MCP's 8_000 instead would have silently shortened the
 *    webhook bodies that path retains, losing provenance to fix a duplicate.
 */

/**
 * Max chars of originating input retained on a proposal as
 * `proposalProvenance.rawSource.rawText`. ENFORCED by `submitCaptureGraph`, and
 * the `.max()` of the Hub REST codec. Do not introduce a second value.
 */
export const RAW_SOURCE_MAX_CHARS = 100_000;

/** Bound originating input to `RAW_SOURCE_MAX_CHARS`. The one truncation door. */
export function boundRawSourceText(text: string): string {
  return text.length > RAW_SOURCE_MAX_CHARS
    ? text.slice(0, RAW_SOURCE_MAX_CHARS)
    : text;
}

/** Chars of the originating instruction quoted into a one-line summary. */
export const SUMMARY_QUOTE_MAX_CHARS = 120;

/** Collapse whitespace and clip to one quotable line. */
function quotable(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > SUMMARY_QUOTE_MAX_CHARS
    ? `${flat.slice(0, SUMMARY_QUOTE_MAX_CHARS - 1).trimEnd()}…`
    : flat;
}

/**
 * A proposal summary that says WHAT and FROM WHERE, in that order of fidelity:
 * a concrete subject beats a quoted instruction beats a bare source URL.
 *
 * Returns `undefined` when the producer genuinely knows none of the three — the
 * caller then omits `summary` and `submitCaptureGraph`'s count string stands as
 * the LAST-RESORT fallback it was always meant to be. Never fabricate a
 * narrative from the entity count; that is the string this exists to replace.
 *
 * `sourceLabel` names the ORIGIN (a product/source name — "Cal.com booking",
 * "Google Calendar event", "Web capture"), not a kind/action/status token, so
 * it is product copy and deliberately NOT routed through
 * `@synap-core/types/vocabulary`. A label that DOES name a domain value must be
 * resolved by the caller before it gets here.
 */
export function buildCaptureNarrativeSummary(input: {
  sourceLabel: string;
  /** A concrete object title from the source (booking title, file name…). */
  subject?: string | null;
  /** The user's originating instruction / captured text. */
  instruction?: string | null;
  /** The URL the capture came from. */
  sourceUrl?: string | null;
}): string | undefined {
  const label = input.sourceLabel.trim();
  if (!label) return undefined;

  const subject = input.subject ? quotable(input.subject) : undefined;
  if (subject) return `${label} — ${subject}`;

  const instruction = input.instruction
    ? quotable(input.instruction)
    : undefined;
  if (instruction) return `${label} — “${instruction}”`;

  const url = input.sourceUrl?.trim();
  if (url) return `${label} — ${url}`;

  return undefined;
}
