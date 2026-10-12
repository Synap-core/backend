/**
 * A NAME the pod derives from longer text — a session from its goal, a run
 * from its automation, a capture from its first line — when no person or agent
 * gave one.
 *
 * Never used on a title someone WROTE: that is stored as sent, or refused over
 * the hard cap. A derived name is the pod's own label, may be improved later by
 * the background titler, and must read as a complete phrase: no "…" (the title
 * rubric flags it as cut, plan 9992207a §3), no dangling word.
 *
 * Shortens at the last clause boundary that keeps most of the budget
 * (". ", " — ", ": ", "; ", " · ", ", ", " (") and otherwise at the last word
 * boundary, then drops trailing punctuation and connector words.
 */
import { TITLE_SOFT_MAX } from "./lint.js";

const CLAUSE_BREAKS = [
  ". ",
  "? ",
  "! ",
  " — ",
  " – ",
  ": ",
  "; ",
  " · ",
  ", ",
  " (",
];

/** Words a phrase must not end on ("Fix the login and"). */
const DANGLING =
  /\s+(?:a|an|the|and|or|but|of|to|for|with|in|on|at|by|from|into|vs|via|is|are|was|be|that|which|when|if|as|de|la|le|les|et|ou|du|des|un|une|pour|avec|dans)$/i;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tidyEnd(value: string): string {
  let out = value.replace(/[\s,;:.\-–—·(]+$/, "");
  // Drop up to three dangling connector words.
  for (let i = 0; i < 3 && DANGLING.test(out); i++) {
    out = out.replace(DANGLING, "").replace(/[\s,;:.\-–—·(]+$/, "");
  }
  return out;
}

export function shortenTitle(
  text: string | null | undefined,
  max = TITLE_SOFT_MAX
): string {
  const line = oneLine(typeof text === "string" ? text : "")
    .replace(/(…|\.\.\.)$/, "")
    .trim();
  if (line.length <= max) return line;
  const window = line.slice(0, max + 1);
  const floor = Math.floor(max * 0.5);
  let cut = -1;
  for (const brk of CLAUSE_BREAKS) {
    const at = window.lastIndexOf(brk);
    if (at >= floor && at > cut) cut = at;
  }
  if (cut === -1) {
    const space = window.lastIndexOf(" ");
    cut = space >= floor ? space : max;
  }
  const shortened = tidyEnd(line.slice(0, cut));
  return shortened || line.slice(0, max);
}
