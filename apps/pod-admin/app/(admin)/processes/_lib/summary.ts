/**
 * A process's one-sentence summary (its description's first sentence). The
 * process pages draw it under the title.
 */

import { oneLine } from "../../../../lib/format";

const SUMMARY_MAX = 200;

/**
 * One sentence on what the process does: its description's first sentence,
 * bounded (the summary line is not the place for the whole brief).
 */
export function processSummary(
  description: string | null | undefined
): string | null {
  const text = description?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return oneLine(sentence, SUMMARY_MAX);
}
