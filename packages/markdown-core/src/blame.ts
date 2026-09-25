/**
 * BLAME — who wrote each line of a document, DERIVED from its history.
 *
 * DOCUMENTS-CENTERPIECE-PLAN §5.1: attribution is never stored as markup in
 * the markdown (relay, export and agents would see it). It is recomputed from
 * the checkpoint chain — the `document_versions` rows, which carry
 * `author` (`ai` | `user`) and `authorId` — so it survives edits by
 * construction.
 *
 * Granularity is the LINE (D-blame: block/line first, word-level only if
 * dogfood asks). `blocks` groups lines into markdown blocks (runs of non-blank
 * lines) for a gutter that marks paragraphs rather than lines.
 *
 * Pure: no I/O, no clock. The caller loads the chain and caches the result per
 * revision.
 */

import { matchSequences } from "./diff.js";

export interface BlameCheckpoint {
  /** Monotonic version of this checkpoint (`document_versions.version`). */
  version: number;
  /** Full markdown at this checkpoint. */
  content: string;
  /** `ai` | `user` today; kept open so a new writer kind needs no change here. */
  authorKind: string;
  /** Agent or user id; null when history did not record one. */
  authorId: string | null;
  /** The proposal whose approval produced this checkpoint, when there was one. */
  proposalId?: string | null;
}

export interface BlameAttribution {
  authorKind: string;
  authorId: string | null;
  version: number;
  proposalId?: string | null;
}

export interface BlameRange extends BlameAttribution {
  /** 1-based, inclusive, over the NEWEST checkpoint's content. */
  startLine: number;
  endLine: number;
}

export interface BlameResult {
  /** One attribution per line of the newest content (index 0 = line 1). */
  lines: BlameAttribution[];
  /** Consecutive lines with the same attribution, merged. */
  ranges: BlameRange[];
  /**
   * Markdown blocks (runs of non-blank lines). A block is attributed to its
   * most recent writer — the last hand on the paragraph — and lists every
   * writer that touched it, oldest first.
   */
  blocks: Array<BlameRange & { authors: BlameAttribution[] }>;
}

function attributionOf(c: BlameCheckpoint): BlameAttribution {
  return {
    authorKind: c.authorKind,
    authorId: c.authorId,
    version: c.version,
    ...(c.proposalId ? { proposalId: c.proposalId } : {}),
  };
}

const same = (a: BlameAttribution, b: BlameAttribution) =>
  a.version === b.version;

/**
 * Attribute every line of the newest checkpoint.
 *
 * @param chain checkpoints OLDEST FIRST. An empty chain has nothing to blame.
 */
export function blame(chain: readonly BlameCheckpoint[]): BlameResult {
  if (chain.length === 0) return { lines: [], ranges: [], blocks: [] };
  const sorted = [...chain].sort((x, y) => x.version - y.version);

  let prevLines = sorted[0]!.content.split("\n");
  let attributions: BlameAttribution[] = prevLines.map(() =>
    attributionOf(sorted[0]!)
  );

  for (const checkpoint of sorted.slice(1)) {
    const nextLines = checkpoint.content.split("\n");
    const mine = attributionOf(checkpoint);
    const next: BlameAttribution[] = nextLines.map(() => mine);
    // Past the matcher's edit-distance bound the step reads as a rewrite:
    // every line goes to the newer checkpoint's author.
    const pairs = matchSequences(prevLines, nextLines);
    if (pairs) for (const [i, j] of pairs) next[j] = attributions[i]!;
    prevLines = nextLines;
    attributions = next;
  }

  const ranges: BlameRange[] = [];
  attributions.forEach((a, i) => {
    const last = ranges[ranges.length - 1];
    if (last && same(last, a) && last.endLine === i) last.endLine = i + 1;
    else ranges.push({ ...a, startLine: i + 1, endLine: i + 1 });
  });

  const blocks: BlameResult["blocks"] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const slice = attributions.slice(start, end);
    const authors = [
      ...new Map(slice.map((a) => [a.version, a])).values(),
    ].sort((x, y) => x.version - y.version);
    blocks.push({
      ...authors[authors.length - 1]!,
      startLine: start + 1,
      endLine: end,
      authors,
    });
    start = -1;
  };
  prevLines.forEach((line, i) => {
    if (line.trim() === "") flush(i);
    else if (start < 0) start = i;
  });
  flush(prevLines.length);

  return { lines: attributions, ranges, blocks };
}
