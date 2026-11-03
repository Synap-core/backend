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
 * Each input repeats one opening that the check scans for and never closes it,
 * at 12, 48 then 192 KB, and must check in under 1 s at each size. A linear
 * check takes about 60 ms at 192 KB in the worst case, so a loaded CI runner
 * has room to spare; a quadratic scan (0.5 s at 48 KB on the old code) passes
 * 48 KB and fails at 192 KB; a worse one fails at the first size in seconds,
 * not hours, because the run stops at the first size over budget. A run over
 * budget by less than 10x is retried twice (a GC pause or a busy core).
 */
const SIZES_KB = [12, 48, 192];
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
        for (const kb of SIZES_KB) {
          const size = kb * 1024;
          const source = opening
            .repeat(Math.ceil(size / opening.length))
            .slice(0, size);
          const ms = bestTime(() => checkCellSource({ source, mechanism }));
          expect(ms, `${kb} KB took ${ms.toFixed(0)} ms`).toBeLessThan(
            BUDGET_MS
          );
        }
      }, 60_000);
    }
  }
});
