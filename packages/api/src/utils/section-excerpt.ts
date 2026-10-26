/**
 * A long text in a fixed budget, chosen for a QUERY: the one excerpt rule the
 * criteria judge (`focus-sessions/evaluations/judge-material.ts`) and the
 * knowledge answer (`services/knowledge/synthesize.ts`) both cut with.
 *
 * A cut by position loses the middle of a long document, which is where the
 * part a question is about often sits. So: one OUTLINE line naming every
 * section as shown or omitted, then the sections the query's words rank
 * highest (the one lexical matcher, `rankByTerms`), laid out in document
 * order with every gap marked `[clipped: N chars omitted]`. Deterministic: no
 * model call. Each caller brings its own sections: the knowledge answer cuts
 * with markdown-core `segmentPassages`; the judge still has its own line
 * splitter (to move onto `segmentPassages` with the passage index, A-W2).
 */
import { rankByTerms } from "./term-match.js";

/** The marker a cut leaves behind, naming how much it dropped. */
export const clipMark = (omitted: number) =>
  `…[clipped: ${omitted} chars omitted]…`;

/** Below this budget an outline + sections is not worth it: head + tail. */
const EXCERPT_MIN = 1_000;

/**
 * ≤ `max` chars. `ends` keeps the head and the tail (a document's verdict and
 * logs are often at its end); `head` keeps only the start.
 */
export function clip(
  s: string,
  max: number,
  keep: "ends" | "head" = "ends"
): string {
  if (s.length <= max) return s;
  // Sized for the widest count (the whole string), so the real mark fits.
  const room = max - clipMark(s.length).length;
  if (room <= 0) return max > 0 ? clipMark(s.length).slice(0, max) : "";
  const mark = clipMark(s.length - room);
  if (keep === "head") return `${s.slice(0, room)}${mark}`;
  const head = Math.ceil(room / 2);
  return `${s.slice(0, head)}${mark}${s.slice(s.length - (room - head))}`;
}

/**
 * One section of a text. A caller's list is contiguous and in document order:
 * concatenated, the sections ARE the text (the gap counts rely on it).
 */
export interface ExcerptSection {
  /** The heading text, or the first words of a heading-less chunk. */
  label: string;
  text: string;
}

/**
 * Pure: `text` in ≤ `budget` chars, chosen for `query`: one OUTLINE line
 * naming every section as shown or omitted, then the sections the query's
 * words rank highest (then the rest, in document order, while they fit), laid
 * out in DOCUMENT order with every gap marked `[clipped: N chars omitted]`.
 * The best section alone over budget is clipped head + tail. Nothing to rank
 * by — one section, a tiny budget, no term hit — is the plain head + tail
 * {@link clip}. `purpose` completes "EXCERPT — chosen for …".
 */
export function excerptByQuery(
  text: string,
  sections: readonly ExcerptSection[],
  budget: number,
  query: string,
  purpose: string
): string {
  if (sections.length < 2 || budget < EXCERPT_MIN) return clip(text, budget);
  const ranked = rankByTerms(
    query,
    sections.map((s, i) => ({ ...s, i })),
    (s) => ({ primary: s.label, tertiary: s.text })
  ).map((r) => r.item.i);
  if (ranked.length === 0) return clip(text, budget);

  const outline = (shown: ReadonlySet<number>) =>
    `EXCERPT — chosen for ${purpose}; every gap is marked "[clipped: N chars omitted]". OUTLINE (${sections.length} sections, ${text.length} chars): ${sections
      .map(
        (s, i) => `${i + 1}. ${s.label} [${shown.has(i) ? "shown" : "omitted"}]`
      )
      .join(" · ")}`;
  // "omitted" is the longer word, so the all-omitted outline bounds the real one.
  const outlineMax = Math.max(200, Math.floor(budget / 4));
  const gapCost = clipMark(text.length).length + 2;
  let room =
    budget - Math.min(outline(new Set()).length, outlineMax) - 1 - gapCost;
  const shown = new Set<number>();
  const partial = new Map<number, string>();
  const rest = sections.map((_, i) => i).filter((i) => !ranked.includes(i));
  for (const i of [...ranked, ...rest]) {
    const cost = sections[i]!.text.length + gapCost;
    if (cost <= room) {
      shown.add(i);
      room -= cost;
    } else if (shown.size === 0) {
      // The best section alone does not fit: its head and tail, marked.
      partial.set(i, clip(sections[i]!.text, room - gapCost));
      shown.add(i);
      break;
    }
  }
  let body = "";
  let gap = 0;
  const flush = () => {
    if (gap > 0) body += `\n${clipMark(gap)}\n`;
    gap = 0;
  };
  sections.forEach((s, i) => {
    if (!shown.has(i)) {
      gap += s.text.length;
      return;
    }
    flush();
    body += partial.get(i) ?? s.text;
  });
  flush();
  return clip(`${clip(outline(shown), outlineMax, "head")}\n${body}`, budget);
}
