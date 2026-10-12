/**
 * A `declarative` renderer's blocks → the segments `DeclarativeBlocks` draws.
 *
 * The schema (`@synap-core/types/renderer-ref`) is a flat list. Drawn one block
 * per row, three stats read as three full-width lines and two buttons as two
 * stacked bars; a run of the same kind belongs on one row. That grouping is the
 * only layout decision, so it lives here as a pure function.
 */

import type { DeclarativeBlock } from "@synap-core/types/renderer-ref";

type Block<T extends DeclarativeBlock["type"]> = Extract<
  DeclarativeBlock,
  { type: T }
>;

export type DeclarativeSegment =
  | { kind: "heading"; block: Block<"heading"> }
  | { kind: "text"; block: Block<"text"> }
  | { kind: "list"; block: Block<"list"> }
  | { kind: "stats"; blocks: Block<"stat">[] }
  | { kind: "buttons"; blocks: Block<"button">[] };

export function declarativeSegments(
  blocks: readonly DeclarativeBlock[]
): DeclarativeSegment[] {
  const out: DeclarativeSegment[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    switch (block.type) {
      case "stat":
        if (last?.kind === "stats") last.blocks.push(block);
        else out.push({ kind: "stats", blocks: [block] });
        break;
      case "button":
        if (last?.kind === "buttons") last.blocks.push(block);
        else out.push({ kind: "buttons", blocks: [block] });
        break;
      case "heading":
        out.push({ kind: "heading", block });
        break;
      case "text":
        out.push({ kind: "text", block });
        break;
      case "list":
        out.push({ kind: "list", block });
        break;
    }
  }
  return out;
}
