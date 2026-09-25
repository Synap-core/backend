/**
 * DIFF — the ONE rule for "what changed between two markdown texts".
 *
 * Every reader that shows a document change draws from here: the proposal
 * review (web `DocumentDiffView` and relay's proposal screen), the editor's
 * inline suggestion marks, version compare, and `blame` (which walks the
 * checkpoint chain with the same matcher). Two screens that diff on their own
 * are two rules the moment one of them is tuned.
 *
 * Granularity:
 * - BLOCKS (paragraphs, headings, lists, fences, containers) are the unit of a
 *   change: markdown's own structure, so a diff never splits a table or an
 *   embed down the middle.
 * - WORDS only inside a changed PROSE block, which is what a reviewer reads:
 *   "we can slip by a week" struck, "a one-week slip moves…" added.
 *
 * Pure: no I/O, no DOM.
 */

/**
 * Past this many edit steps the matcher stops searching and reports "no
 * match": the caller treats the step as a rewrite. Bounds memory at ~16 MB.
 */
const MAX_EDIT_DISTANCE = 2000;

/**
 * Myers' O((N+M)·D) diff: the index pairs of an LCS of `a` and `b`, or null
 * when the edit distance exceeds `maxDistance`.
 */
export function matchSequences(
  a: readonly string[],
  b: readonly string[],
  maxDistance: number = MAX_EDIT_DISTANCE
): Array<[number, number]> | null {
  // Common prefix / suffix are matched without search.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < pre; i++) pairs.push([i, i]);

  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const middle: Array<[number, number]> = [];
  if (n > 0 && m > 0) {
    const max = n + m;
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    // trace[d] = v[-d..d] BEFORE round d, stored compactly.
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max; d++) {
      if (d > maxDistance) return null;
      trace.push(v.slice(off - d, off + d + 1));
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
            ? v[off + k + 1]!
            : v[off + k - 1]! + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    // Backtrack.
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
      const t = trace[d]!;
      const at = (k: number) => t[k + d]!;
      const k = x - y;
      const prevK =
        k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const prevX = d === 0 ? 0 : at(prevK);
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        middle.push([pre + x - 1, pre + y - 1]);
        x--;
        y--;
      }
      x = prevX;
      y = prevY;
    }
    middle.reverse();
  }
  pairs.push(...middle);
  for (let i = suf; i > 0; i--) pairs.push([a.length - i, b.length - i]);
  return pairs;
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const CONTAINER_OPEN = /^\s{0,3}(:{3,})\s*[A-Za-z]/;
const CONTAINER_CLOSE = /^\s{0,3}(:{3,})\s*$/;

/**
 * Split markdown into blocks: runs of non-blank lines. A blank line inside a
 * code fence or a `:::` container does not end the block, so an embed and its
 * JSON body, or a code sample, stay one unit.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let depth = 0;
  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of markdown.split("\n")) {
    if (fence) {
      current.push(line);
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      current.push(line);
      fence = f[1]!;
      continue;
    }
    if (CONTAINER_OPEN.test(line)) {
      depth++;
      current.push(line);
      continue;
    }
    if (depth > 0 && CONTAINER_CLOSE.test(line)) {
      depth--;
      current.push(line);
      if (depth === 0) flush();
      continue;
    }
    if (line.trim() === "" && depth === 0) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

// ─── Words ───────────────────────────────────────────────────────────────────

export interface DiffWordSegment {
  op: "same" | "add" | "del";
  text: string;
}

/** Word-level diff of two strings; whitespace travels with the words. */
export function diffWords(before: string, after: string): DiffWordSegment[] {
  const a = before.split(/(\s+)/).filter((t) => t !== "");
  const b = after.split(/(\s+)/).filter((t) => t !== "");
  const pairs = matchSequences(a, b) ?? [];
  const out: DiffWordSegment[] = [];
  const push = (op: DiffWordSegment["op"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    while (i < pi) push("del", a[i++]!);
    while (j < pj) push("add", b[j++]!);
    if (pi < a.length && pj < b.length) {
      push("same", a[pi]!);
      i = pi + 1;
      j = pj + 1;
    }
  }
  return out;
}

// ─── Block diff ──────────────────────────────────────────────────────────────

export type DiffBlock =
  | { op: "same"; text: string }
  | { op: "add"; text: string }
  | { op: "del"; text: string }
  | {
      op: "change";
      before: string;
      after: string;
      /** Word segments, present only when both sides are plain prose. */
      words?: DiffWordSegment[];
    };

/**
 * Characters that make an inline word diff unsafe: wrapping a word diff in
 * `~~`/`==` markers across emphasis, links, code, embeds or html would change
 * what the block renders. Such blocks diff as whole blocks instead.
 */
const INLINE_MARKUP =
  /[\[\]*_`~=<>|\\]|^\s{0,3}(#|>|[-+*]\s|\d+[.)]\s|:{3,}|```|~~~)/m;

/** A single-line-or-wrapped paragraph with no inline markup. */
export function isPlainProse(block: string): boolean {
  return block.trim() !== "" && !INLINE_MARKUP.test(block);
}

/**
 * Block diff of two markdown texts. A deletion run followed by an addition run
 * is paired position by position into `change` blocks (the edited paragraph),
 * the rest stay `del` / `add`.
 */
export function diffBlocks(before: string, after: string): DiffBlock[] {
  const a = splitMarkdownBlocks(before);
  const b = splitMarkdownBlocks(after);
  const pairs = matchSequences(a, b) ?? [];
  const out: DiffBlock[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    const dels = a.slice(i, pi);
    const adds = b.slice(j, pj);
    const paired = Math.min(dels.length, adds.length);
    for (let k = 0; k < paired; k++) {
      const was = dels[k]!;
      const now = adds[k]!;
      out.push({
        op: "change",
        before: was,
        after: now,
        ...(isPlainProse(was) && isPlainProse(now)
          ? { words: diffWords(was, now) }
          : {}),
      });
    }
    for (const text of dels.slice(paired)) out.push({ op: "del", text });
    for (const text of adds.slice(paired)) out.push({ op: "add", text });
    if (pi < a.length && pj < b.length) out.push({ op: "same", text: a[pi]! });
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

/** Whether a block diff holds any change at all. */
export function hasBlockChanges(blocks: readonly DiffBlock[]): boolean {
  return blocks.some((b) => b.op !== "same");
}

/**
 * The markdown of a word-diffed prose block, with deletions as `~~…~~` and
 * additions as `==…==` — what a markdown renderer draws as struck / marked
 * text. Only valid for segments from a plain-prose `change` (no authored `~`
 * or `=` to be confused with). Whitespace stays outside the markers, where
 * GFM requires it.
 */
export function wordDiffMarkdown(segments: readonly DiffWordSegment[]): string {
  return segments
    .map(({ op, text }) => {
      if (op === "same") return text;
      const marker = op === "del" ? "~~" : "==";
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
      return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : text;
    })
    .join("");
}

// ─── Sections ────────────────────────────────────────────────────────────────

const SECTION_OPEN = /^\s{0,3}:{3,}\s*synap-section\b/;

/**
 * The body of a `:::synap-section` container (opener and closer stripped), or
 * the text unchanged when it is not one. A section preview carries the whole
 * container, and diffing it whole would make the section ONE block — every
 * edit inside it a rewrite of everything.
 */
export function sectionContainerBody(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 2 || !SECTION_OPEN.test(lines[0]!)) return text;
  if (!CONTAINER_CLOSE.test(lines[lines.length - 1]!)) return text;
  return lines.slice(1, -1).join("\n");
}

/** Block diff of one section's before/after, inside its container. */
export function diffSection(before: string, after: string): DiffBlock[] {
  return diffBlocks(sectionContainerBody(before), sectionContainerBody(after));
}
