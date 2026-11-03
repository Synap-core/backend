import { describe, expect, it } from "vitest";
import { checkCellSource } from "./cell-source-checks.js";

/**
 * `checkCellSource` runs on the pod's request thread (defineCell and the cell
 * proposal doors), on a source any agent can send. A scan whose cost grows
 * faster than the source would let one write stall every other request: the
 * first version took 29 s on 20 KB of `<div onclick ` (an unbounded `[^>]*`
 * with no closing `>`), and 0.4-0.5 s on 20 KB of `import `, `<img ` or
 * `<script ` (a line count from the start of the text for every hit, a lazy
 * import clause, unclosed comment scans).
 *
 * Each input repeats one opening that the check scans for and never closes it.
 * At 48 KB the old scans took 2-3 s for the quadratic ones and minutes for
 * `<div onclick `; the linear check takes a few milliseconds. The 1 s budget
 * leaves a loaded CI runner two orders of magnitude of slack, and a run over it
 * by less than 10x is retried twice (a GC pause or a busy core), so only a
 * scan that really grows faster than the source turns this red.
 */
const SIZE = 48 * 1024;
const BUDGET_MS = 1000;
const ATTEMPTS = 3;

/** The fastest of up to {@link ATTEMPTS} runs, stopping at the first under budget or far over it. */
function bestTime(run: () => void): number {
  let best = Infinity;
  for (let i = 0; i < ATTEMPTS; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
    if (best < BUDGET_MS || best > 10 * BUDGET_MS) break;
  }
  return best;
}

const OPENINGS = [
  "<script ",
  "<script>",
  "<link ",
  '<link rel="stylesheet" ',
  "<img ",
  "<div onclick ",
  "<span onClick=x ",
  "<!--",
  "\n/*",
  "\n  // x",
  "import ",
  "import {",
  "import a, ",
  "export ",
  'import("',
  "a from ",
  "@import ",
  'fetch("//',
  "new WebSocket(",
  "#abc ",
  "https://esm.sh/",
];

describe("checkCellSource answers in time linear in the source", () => {
  for (const opening of OPENINGS) {
    for (const mechanism of ["frame", "iframe"] as const) {
      it(`${JSON.stringify(opening)} repeated, ${mechanism}`, () => {
        const source = opening
          .repeat(Math.ceil(SIZE / opening.length))
          .slice(0, SIZE);
        expect(
          bestTime(() => checkCellSource({ source, mechanism }))
        ).toBeLessThan(BUDGET_MS);
      });
    }
  }
});
