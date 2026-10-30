/**
 * MERGE — the ONE rule for "combine two edits of the same text".
 *
 * A line-level 3-way merge (diff3): `base` is the text both sides started
 * from, `ours` and `theirs` are two edits of it. A region only one side
 * changed takes that side; a region both sides changed identically takes it
 * once; a region both sides changed differently is a CONFLICT. Two edits
 * with no unchanged line between them are one region, so edits that touch or
 * abut each other conflict: the safe reading, since a person must look.
 *
 * `merged` is offered only when there is no conflict (design decision D2 of
 * the package-update plan: "Combine both" is recommended only when the two
 * sides do not overlap). Lines are matched with the same matcher every diff
 * reader uses (`matchSequences`, ./diff.ts).
 *
 * Pure: no I/O, no DOM.
 */

import { matchSequences } from "./diff.js";

/** One region both sides changed, differently. */
export interface MergeConflict {
  /** 0-based line of `base` where the region starts. */
  baseLine: number;
  base: string;
  ours: string;
  theirs: string;
}

export interface TextMerge {
  /** The combined text, or null when the two edits conflict. */
  merged: string | null;
  conflicts: MergeConflict[];
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** `map[i]` = the line of `other` base line `i` is matched to, or -1. */
function matchMap(
  base: readonly string[],
  other: readonly string[]
): Int32Array | null {
  const pairs = matchSequences(base, other);
  if (!pairs) return null;
  const map = new Int32Array(base.length).fill(-1);
  for (const [i, j] of pairs) map[i] = j;
  return map;
}

export function mergeText3(
  base: string,
  ours: string,
  theirs: string
): TextMerge {
  if (ours === theirs || theirs === base)
    return { merged: ours, conflicts: [] };
  if (ours === base) return { merged: theirs, conflicts: [] };

  const b = base.split("\n");
  const o = ours.split("\n");
  const t = theirs.split("\n");
  const mo = matchMap(b, o);
  const mt = matchMap(b, t);
  if (!mo || !mt) {
    // Too far apart to match line by line: the whole text is one region.
    return {
      merged: null,
      conflicts: [{ baseLine: 0, base, ours, theirs }],
    };
  }

  const out: string[] = [];
  const conflicts: MergeConflict[] = [];
  let i = 0;
  let io = 0;
  let it = 0;
  while (i < b.length || io < o.length || it < t.length) {
    // A line every side kept, at the cursor: copy it.
    if (i < b.length && mo[i] === io && mt[i] === it) {
      out.push(b[i]!);
      i++;
      io++;
      it++;
      continue;
    }
    // Otherwise the region runs to the next line every side kept.
    let j = i;
    while (j < b.length && (mo[j] === -1 || mt[j] === -1)) j++;
    const jo = j < b.length ? mo[j]! : o.length;
    const jt = j < b.length ? mt[j]! : t.length;
    const bs = b.slice(i, j);
    const os = o.slice(io, jo);
    const ts = t.slice(it, jt);
    if (sameLines(os, bs)) out.push(...ts);
    else if (sameLines(ts, bs) || sameLines(os, ts)) out.push(...os);
    else {
      conflicts.push({
        baseLine: i,
        base: bs.join("\n"),
        ours: os.join("\n"),
        theirs: ts.join("\n"),
      });
    }
    i = j;
    io = jo;
    it = jt;
  }

  return conflicts.length > 0
    ? { merged: null, conflicts }
    : { merged: out.join("\n"), conflicts: [] };
}
