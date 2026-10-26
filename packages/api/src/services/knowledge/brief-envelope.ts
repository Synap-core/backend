/**
 * The ENVELOPE a `detail: "brief"` ask returns around its short answer.
 *
 * `brief` used to shape only the prose (the IS prompt and token budget); the
 * payload around it had no budget, so one brief ask came back 62,594 chars and
 * overran client tool-output limits. Under `brief` the envelope is capped: a
 * few sources, one-line pending summaries, no `spaces` routing hint. `full`
 * is untouched, and `sources` is the caller asking for the whole list.
 */
import type { AskPendingBlock } from "./ask.js";
import type { AskDetail, SynthesisResult } from "./synthesize.js";

export const BRIEF_MAX_SOURCES = 5;
export const BRIEF_PENDING_SUMMARY_CAP = 200;

export function capBriefEnvelope<P extends AskPendingBlock | undefined>(
  detail: AskDetail | undefined,
  synthesis: SynthesisResult,
  pending: P
): {
  synthesis: SynthesisResult & { sourcesOmitted?: number };
  pending: P;
  /** `spaces` is dropped under brief; every other detail forwards it. */
  keepSpaces: boolean;
} {
  if (detail !== "brief") return { synthesis, pending, keepSpaces: true };
  const cut = synthesis.sources.length - BRIEF_MAX_SOURCES;
  return {
    synthesis:
      cut > 0
        ? {
            ...synthesis,
            sources: synthesis.sources.slice(0, BRIEF_MAX_SOURCES),
            sourcesOmitted: cut,
          }
        : synthesis,
    pending: (pending
      ? {
          ...pending,
          matches: pending.matches.map((m) =>
            m.summary && m.summary.length > BRIEF_PENDING_SUMMARY_CAP
              ? {
                  ...m,
                  summary: `${m.summary.slice(0, BRIEF_PENDING_SUMMARY_CAP)}…`,
                }
              : m
          ),
        }
      : pending) as P,
    keepSpaces: false,
  };
}
