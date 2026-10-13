/**
 * No runtime import cycle inside `lifecycle/`.
 *
 * `index.ts` re-exports `steps.ts`, and `steps.ts` once imported its option
 * helpers back from `index.ts`. A dev bundle that reads a module's exports
 * eagerly (React Refresh in Metro) then hit `STEP_POSITIONS` in its temporal
 * dead zone, and relay web died at boot. Hermes does not enforce the TDZ, so
 * the phone never showed it.
 *
 * Scope, measured: edges are the RELATIVE `import`/`export … from` statements
 * of the folder's non-test files, minus whole-statement `import type` /
 * `export type` and statements whose every specifier is `type`. It does not
 * see cycles that leave the folder (e.g. through `../vocabulary`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = dirname(fileURLToPath(import.meta.url));

const STATEMENT =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"(\.\/[^"]+)\.js"/g;

export function runtimeEdges(source: string): string[] {
  const edges: string[] = [];
  for (const m of source.matchAll(STATEMENT)) {
    if (m[2]) continue; // `import type …` / `export type …`
    const clause = m[3] ?? "";
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced && !clause.replace(braced[0], "").replace(/,/g, "").trim()) {
      const specifiers = braced[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (specifiers.every((s) => s.startsWith("type "))) continue;
    }
    edges.push(`${m[4]!.slice(2)}.ts`);
  }
  return edges;
}

function graph(): Map<string, string[]> {
  const files = readdirSync(DIR).filter(
    (f) =>
      f.endsWith(".ts") && !f.includes(".test.") && !f.includes(".contract.")
  );
  return new Map(
    files.map((f) => [f, runtimeEdges(readFileSync(join(DIR, f), "utf8"))])
  );
}

function findCycle(g: Map<string, string[]>): string[] | null {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === "done") return null;
    if (state.get(n) === "open") return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, "open");
    stack.push(n);
    for (const next of g.get(n) ?? []) {
      const c = visit(next);
      if (c) return c;
    }
    stack.pop();
    state.set(n, "done");
    return null;
  };
  for (const n of g.keys()) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

describe("lifecycle/ import graph", () => {
  it("sees the folder (non-vacuity)", () => {
    const g = graph();
    expect(g.size).toBeGreaterThanOrEqual(5);
    expect(g.get("index.ts")).toContain("steps.ts");
    expect(g.get("steps.ts")).toContain("option.ts");
  });

  it("the edge reader keeps value imports and drops type-only ones", () => {
    expect(runtimeEdges('import { a, type B } from "./x.js";')).toEqual([
      "x.ts",
    ]);
    expect(runtimeEdges('import { type B } from "./x.js";')).toEqual([]);
    expect(runtimeEdges('import type { B } from "./x.js";')).toEqual([]);
    expect(runtimeEdges('export {\n  a,\n  type B,\n} from "./x.js";')).toEqual(
      ["x.ts"]
    );
  });

  it("has no runtime cycle", () => {
    expect(findCycle(graph())).toBeNull();
  });
});
