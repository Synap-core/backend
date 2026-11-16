/**
 * The ORDER of a process page's blocks — one list every surface reads (the
 * desktop process page, pod admin's `/processes`), so two surfaces never draw
 * a process in two orders. The health mark heads the page; it is not a block.
 *
 * The order follows the process read contract (`ProcessRead`): what starts it,
 * the steps it takes, how it is checked, what it moves, what it needs, the
 * skills it loads, then its runs (what was already made comes last,
 * rules/ui-composition).
 */
import type { ProcessRead } from "./read.js";

export const PROCESS_BLOCKS = [
  "when",
  "steps",
  "checks",
  "moves",
  "needs",
  "skills",
  "runs",
] as const satisfies ReadonlyArray<keyof ProcessRead>;
export type ProcessBlock = (typeof PROCESS_BLOCKS)[number];

/**
 * Whether a block has nothing to draw (a surface OMITS an empty block). A
 * block whose read FAILED is never empty: the surface explains it instead
 * (an empty result and a failed read are different facts).
 */
export function processBlockIsEmpty(
  read: ProcessRead,
  block: ProcessBlock
): boolean {
  if ((read.unavailable as readonly string[]).includes(block)) return false;
  switch (block) {
    case "when":
      return (
        read.when.automations.length === 0 &&
        read.when.workers.length === 0 &&
        !read.when.manualStart
      );
    case "steps":
      return read.steps.length === 0;
    case "checks":
      return (
        read.checks.criteria.length === 0 && read.checks.gates.length === 0
      );
    case "moves":
      return read.moves === null;
    case "needs":
      return read.needs.length === 0;
    case "skills":
      return read.skills.length === 0;
    case "runs":
      return (
        read.runs.recent.length === 0 &&
        (read.runs.counts.total ?? 0) === 0 &&
        (read.runs.counts.open ?? 0) === 0
      );
  }
}
