/**
 * A process's one-sentence summary (its description, else its goal template
 * with each reference read as its name). The process pages draw it under the
 * title.
 */

import { oneLine } from "../../../../lib/format";

const SUMMARY_MAX = 200;

/** `@{arg:topic}` and `{topic}` — a goal's references, read as their names. */
const ARG_REF = /@\{arg:([^}]+)\}|\{([A-Za-z_][\w.-]*)\}/g;

/**
 * One sentence on what the template does: its description when it has one,
 * else its goal template with each reference read as ‹name›. First sentence
 * only, bounded — the summary line is not the place for the whole brief.
 */
export function templateSummary(
  description: string | null | undefined,
  goalTemplate: string | null | undefined
): string | null {
  const source = description?.trim() || goalTemplate?.trim();
  if (!source) return null;
  const text = withArgNames(source).replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return oneLine(sentence, SUMMARY_MAX);
}

/** Each goal reference read as its name (‹topic›). */
function withArgNames(text: string): string {
  return text.replace(
    ARG_REF,
    (_m, arg?: string, bare?: string) => `‹${(arg ?? bare ?? "").trim()}›`
  );
}
