/**
 * A document edit proposal's `preview` (`{sectionId, title, before, after}`
 * per affected region, `services/document-patch/patch-ops.ts`) → what a
 * reviewer reads: per region, the paragraphs that change, with what stayed
 * the same folded to a count. Pure; reads only the payload the proposal
 * already carries, so it shows nothing the raw request did not.
 */

import {
  diffSection,
  isFrameFenceBlock,
  type DiffBlock,
} from "@synap-core/markdown-core/diff";

export type ChangeLine =
  | { op: "unchanged"; count: number }
  | { op: "add"; text: string }
  | { op: "del"; text: string }
  | {
      op: "change";
      before: string;
      after: string;
      /** Word by word, when both sides are plain prose. */
      words?: Array<{ op: "same" | "add" | "del"; text: string }>;
    };

export interface DocumentChange {
  key: string;
  /** The section's heading, or null for text outside any section. */
  title: string | null;
  lines: ChangeLine[];
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

/** Same blocks fold into one "N unchanged" line; layout fences drop out. */
function linesOf(blocks: readonly DiffBlock[]): ChangeLine[] {
  const out: ChangeLine[] = [];
  for (const block of blocks) {
    if (block.op === "same") {
      const last = out[out.length - 1];
      if (last?.op === "unchanged") last.count += 1;
      else out.push({ op: "unchanged", count: 1 });
      continue;
    }
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
    lines: linesOf(diffSection(entry.before, entry.after)),
  }));
  const real = changes.filter((c) => c.lines.some((l) => l.op !== "unchanged"));
  return real.length > 0 ? real : null;
}
