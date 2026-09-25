/**
 * Tripwire: the chart shapers exist ONCE. The browser's live chart, its
 * "Freeze", and the server-side freeze of report charts all shape entity rows
 * through `chart-shapers.ts`; a second copy anywhere would let a frozen
 * snapshot and the live chart draw different numbers from the same rows.
 *
 * The hunted names are DERIVED from this module's function exports, and the
 * scanned set is every source file under the repos that draw or freeze charts.
 * Limit: it finds a re-DEFINITION by name (`function X(` / `const X =`); a
 * copy renamed to something else is not caught.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as shapers from "./chart-shapers.js";

const MONOREPO = join(import.meta.dirname, "..", "..", "..", "..", "..");
const ROOTS = [
  "synap-backend/packages",
  "synap-app/packages",
  "browser/electron",
  "relay-app/src",
  "synap-intelligence-service/apps",
].map((r) => join(MONOREPO, r));
const SKIP = new Set([
  "node_modules",
  "dist",
  ".next",
  "build",
  ".turbo",
  "coverage",
]);

function sources(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sources(p, out);
    else if (
      /\.(ts|tsx|mts|js|mjs)$/.test(name) &&
      !/\.test\.|\.d\.ts$/.test(name)
    )
      out.push(p);
  }
  return out;
}

const NAMES = Object.entries(shapers)
  .filter(([, v]) => typeof v === "function" || (v && typeof v === "object"))
  .map(([k]) => k);
const files = ROOTS.flatMap((r) => sources(r));

describe("chart shapers: one implementation", () => {
  it("hunts every shaper and scans a real tree (non-vacuity)", () => {
    // Every scanned repo must be checked out (the monorepo layout), or the scan
    // would pass by not looking — same loud rule as the socket-event tripwire.
    for (const root of ROOTS)
      expect(existsSync(root), `missing ${root}`).toBe(true);
    for (const n of [
      "buildSeries",
      "buildDistribution",
      "shapeChartEntities",
      "CHART_QUERY_SHAPERS",
    ]) {
      expect(NAMES).toContain(n);
    }
    expect(files.length).toBeGreaterThan(1000);
  });

  it.each(NAMES)("%s is defined exactly once — in chart-shapers.ts", (name) => {
    const def = new RegExp(
      `\\b(?:function\\s+${name}\\s*[(<]|(?:const|let|var)\\s+${name}\\s*[=:])`
    );
    expect(def.test(`export function ${name}(x) {}`)).toBe(true); // the scan can see a definition
    const hits = files
      .filter((f) => def.test(readFileSync(f, "utf8")))
      .map((f) => relative(MONOREPO, f));
    expect(hits).toEqual([
      "synap-backend/packages/types/src/renderables/chart-shapers.ts",
    ]);
  });
});
