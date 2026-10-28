/**
 * A text change as a reviewer reads it: the WHOLE text, every block in its
 * place, with what goes and what comes marked where it happens. Used for a
 * document edit proposal's `preview` (`{sectionId, title, before, after}` per
 * affected region, `services/document-patch/patch-ops.ts`) and for any long
 * text a proposal rewrites (a skill's instructions, a playbook's goal, a
 * note's body). The diff rule is `@synap-core/markdown-core/diff`, the one the
 * desktop and the phone draw; this module keeps what stayed the same (folded
 * by the view, never dropped) and adds a line-by-line reading of the source.
 * Pure; reads only the payload the proposal already carries.
 */

import {
  diffSection,
  diffWords,
  isFrameFenceBlock,
  matchSequences,
  type DiffBlock,
} from "@synap-core/markdown-core/diff";

export type WordSegment = { op: "same" | "add" | "del"; text: string };

export type ChangeLine =
  | { op: "same"; text: string }
  | { op: "add"; text: string }
  | { op: "del"; text: string }
  | {
      op: "change";
      before: string;
      after: string;
      /** Word by word, when both sides are plain prose. */
      words?: WordSegment[];
    };

/** One text, before and after, with its blocks in order. */
export interface TextChange {
  before: string;
  after: string;
  lines: ChangeLine[];
}

export interface DocumentChange extends TextChange {
  key: string;
  /** The section's heading, or null for text outside any section. */
  title: string | null;
}

function isPreviewEntry(value: unknown): value is {
  sectionId?: unknown;
  title?: unknown;
  before: string;
  after: string;
} {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.before === "string" && typeof v.after === "string";
}

/** Every block in order; layout fences (a columns row's frame) drop out. */
function linesOf(blocks: readonly DiffBlock[]): ChangeLine[] {
  const out: ChangeLine[] = [];
  for (const block of blocks) {
    if (block.op === "change") {
      if (isFrameFenceBlock(block.before) && isFrameFenceBlock(block.after)) {
        continue;
      }
      out.push(block);
      continue;
    }
    if (isFrameFenceBlock(block.text)) continue;
    out.push(block);
  }
  return out;
}

/** True when at least one block is added, removed or edited. */
export function hasChanges(lines: readonly ChangeLine[]): boolean {
  return lines.some((l) => l.op !== "same");
}

/** One text's rewrite, block by block, the unchanged blocks kept in place. */
export function textChanges(before: string, after: string): ChangeLine[] {
  return linesOf(diffSection(before, after));
}

/**
 * The changes a document edit proposal asks for, or null when its payload
 * carries no preview (another kind of proposal, or an older one).
 */
export function documentChanges(payload: unknown): DocumentChange[] | null {
  if (!payload || typeof payload !== "object") return null;
  const preview = (payload as { preview?: unknown }).preview;
  if (!Array.isArray(preview)) return null;
  const changes = preview.filter(isPreviewEntry).map((entry, i) => ({
    key:
      typeof entry.sectionId === "string" && entry.sectionId
        ? entry.sectionId
        : `region-${i}`,
    title:
      typeof entry.title === "string" && entry.title.trim()
        ? entry.title.trim()
        : null,
    before: entry.before,
    after: entry.after,
    lines: textChanges(entry.before, entry.after),
  }));
  const real = changes.filter((c) => hasChanges(c.lines));
  return real.length > 0 ? real : null;
}

// ─── Lines: the source, line by line ─────────────────────────────────────────

export type LineRow =
  | { op: "same"; text: string; oldNo: number; newNo: number }
  | { op: "del"; text: string; oldNo: number; words?: WordSegment[] }
  | { op: "add"; text: string; newNo: number; words?: WordSegment[] };

/** A line longer than this is marked whole, not word by word. */
const WORD_DIFF_MAX_CHARS = 2_000;

/**
 * Word segments for a removed line and the line that replaced it, or null
 * when the two share no word (then each is simply marked whole).
 */
function pairWords(
  del: string,
  add: string
): { del: WordSegment[]; add: WordSegment[] } | null {
  if (!del.trim() || !add.trim()) return null;
  if (del.length > WORD_DIFF_MAX_CHARS || add.length > WORD_DIFF_MAX_CHARS) {
    return null;
  }
  const words = diffWords(del, add);
  if (!words.some((w) => w.op === "same" && w.text.trim())) return null;
  return {
    del: words.filter((w) => w.op !== "add"),
    add: words.filter((w) => w.op !== "del"),
  };
}

/**
 * The two texts line by line (the source, as a code review reads it), with
 * line numbers on both sides. Inside a block of replaced lines, each removed
 * line is paired with the line that took its place and diffed word by word.
 * Past the matcher's edit budget the whole text reads as removed then added.
 */
export function lineDiff(before: string, after: string): LineRow[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const pairs = matchSequences(a, b) ?? [];
  const rows: LineRow[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as const]) {
    const dels = a.slice(i, pi);
    const adds = b.slice(j, pj);
    const paired = dels.map((d, k) =>
      k < adds.length ? pairWords(d, adds[k]!) : null
    );
    dels.forEach((text, k) => {
      const words = paired[k]?.del;
      rows.push({
        op: "del",
        text,
        oldNo: i + k + 1,
        ...(words ? { words } : {}),
      });
    });
    adds.forEach((text, k) => {
      const words = k < paired.length ? paired[k]?.add : undefined;
      rows.push({
        op: "add",
        text,
        newNo: j + k + 1,
        ...(words ? { words } : {}),
      });
    });
    if (pi < a.length && pj < b.length) {
      rows.push({ op: "same", text: a[pi]!, oldNo: pi + 1, newNo: pj + 1 });
    }
    i = pi + 1;
    j = pj + 1;
  }
  return rows;
}

/** How many lines a text change adds and removes, line by line. */
export function lineCounts(rows: readonly LineRow[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.op === "add") added += 1;
    else if (row.op === "del") removed += 1;
  }
  return { added, removed };
}

// ─── Folding: what the reader sees first ─────────────────────────────────────

export type Folded<T> =
  | { kind: "row"; row: T; index: number }
  | { kind: "fold"; rows: T[]; from: number };

/**
 * Unchanged rows far from a change fold into one quiet row the reader can
 * open; `context` unchanged rows stay visible on each side of every change.
 * A fold of a single row is not worth a control, so it stays visible. Nothing
 * is ever dropped: a fold carries its rows.
 */
export function foldUnchanged<T>(
  rows: readonly T[],
  isSame: (row: T) => boolean,
  context: number
): Folded<T>[] {
  const keep = rows.map((row) => !isSame(row));
  const changed = keep.flatMap((k, i) => (k ? [i] : []));
  for (const c of changed) {
    for (let d = 1; d <= context; d++) {
      if (c - d >= 0) keep[c - d] = true;
      if (c + d < rows.length) keep[c + d] = true;
    }
  }
  const out: Folded<T>[] = [];
  let run: { from: number; rows: T[] } | null = null;
  const flush = () => {
    if (!run) return;
    if (run.rows.length === 1) {
      out.push({ kind: "row", row: run.rows[0]!, index: run.from });
    } else {
      out.push({ kind: "fold", rows: run.rows, from: run.from });
    }
    run = null;
  };
  rows.forEach((row, index) => {
    if (keep[index]) {
      flush();
      out.push({ kind: "row", row, index });
      return;
    }
    if (run) run.rows.push(row);
    else run = { from: index, rows: [row] };
  });
  flush();
  return out;
}
